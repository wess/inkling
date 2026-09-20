import { from } from "atlas/db"
import { badRequest, del, get, json, pipeline, post, putHeader, redirect } from "atlas/server"
import { auth, requireAuth, requireCan } from "../../src/auth/guard.ts"
import { can } from "../../src/auth/roles.ts"
import { one } from "../../src/db/dialect.ts"
import { noStore } from "../../src/http/index.ts"
import { packState, readState } from "../../src/oauth/index.ts"
import type { PluginContext } from "../../src/plugins/define.ts"
import { createAudit, createRateLimit } from "../../src/security/index.ts"
import { tokenRequest } from "./api.ts"
import { callback, checkCallback, configured, host, SCOPES, settings } from "./config.ts"
import { current, matches, save } from "./connection.ts"

type Pending = { plugin: string; userId: string; clientId: string; environment: string; redirectUri: string }
const cookieName = "inkling_square"
const digest = (raw: string): string => new Bun.CryptoHasher("sha256").update(raw).digest("hex")
const cookie = (value: string, age = 600): string =>
  `${cookieName}=${value}; Path=/ext/square; HttpOnly; SameSite=Lax; Max-Age=${age}${callback().startsWith("https:") ? "; Secure" : ""}`

export const oauthRoutes = (ctx: PluginContext) => {
  const admin = pipeline(noStore, requireAuth(ctx.db), requireCan(can.managePlugins, "connect Square"))
  return [
    get(
      "/connections",
      admin(async c => {
        const s = await settings(ctx)
        const row = await current(ctx.db)
        return json(c, 200, {
          data: {
            redirectUri: callback(),
            connections: [
              {
                id: "square",
                label: `Square (${s.environment})`,
                configured: configured(s),
                hint: "Ask your website manager to configure the Square application for this site, then press Connect.",
                scopes: SCOPES,
                connection: row
                  ? {
                      id: row.id,
                      account: row.merchant_id,
                      expiresAt: row.expires_at,
                      error: matches(row, s) ? null : "The Square application changed. Reconnect this account.",
                      connectedAt: row.connected_at,
                    }
                  : null,
              },
            ],
          },
        })
      }),
    ),
    post(
      "/connections/:id/start",
      admin(async c => {
        if (c.params.id !== "square") throw badRequest("Unknown shop provider")
        const s = await settings(ctx)
        if (!configured(s)) throw badRequest("Your website manager needs to configure the Square application first")
        checkCallback(s)
        const allowed = await createRateLimit(ctx.db).check(`square:connect:${auth(c).id}`, 10, 600)
        if (!allowed.ok) return json(c, 429, { error: "Too many connection attempts. Please wait a few minutes." })
        const { state, expires } = await packState<Pending>(
          {
            plugin: "square",
            userId: auth(c).id,
            clientId: s.clientId,
            environment: s.environment,
            redirectUri: callback(),
          },
          crypto.randomUUID(),
        )
        const hash = digest(state)
        await ctx.db.execute(
          from("square_oauth")
            .where(q => q("expires_at").lessThan(new Date().toISOString()))
            .del(),
        )
        await ctx.db.execute(from("square_oauth").insert({ id: hash, expires_at: new Date(expires).toISOString() }))
        const url = new URL(`${host(s)}/oauth2/authorize`)
        url.search = new URLSearchParams({
          client_id: s.clientId,
          scope: SCOPES.join(" "),
          session: "false",
          state,
          redirect_uri: callback(),
        }).toString()
        return json(putHeader(c, "set-cookie", cookie(hash)), 200, {
          data: { url: url.toString(), expiresAt: new Date(expires).toISOString() },
        })
      }),
    ),
    get("/callback", async c => {
      const back = (outcome: string) =>
        redirect(
          putHeader(noStore(c), "set-cookie", cookie("", 0)),
          `${ctx.adminBase}/plugins/square/setup?connected=${outcome}${outcome === "error" ? "&reason=Square%20did%20not%20connect.%20Please%20try%20again%20from%20Setup." : ""}`,
        )
      const raw = typeof c.query.state === "string" ? c.query.state : ""
      const pending = await readState<Pending>(raw)
      const bound = (c.headers.get("cookie") ?? "")
        .split(";")
        .map(part => part.trim())
        .find(part => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1)
      if (!pending || pending.plugin !== "square" || bound !== digest(raw)) return back("error")
      const claimed = await ctx.db.execute(
        from("square_oauth")
          .where(q => q("id").equals(digest(raw)))
          .del()
          .returning("id"),
      )
      if (!claimed.length || c.query.error || typeof c.query.code !== "string") return back("error")
      const s = await settings(ctx)
      const actor = await one<{ id: string; role: string; deleted_at: string | null }>(
        ctx.db,
        from("users").where(q => q("id").equals(pending.userId)),
      )
      if (
        !configured(s) ||
        pending.clientId !== s.clientId ||
        pending.environment !== s.environment ||
        pending.redirectUri !== callback() ||
        !actor ||
        actor.deleted_at ||
        !can.managePlugins(actor.role)
      )
        return back("error")
      try {
        const tokens = await tokenRequest(s, {
          grant_type: "authorization_code",
          code: c.query.code,
          redirect_uri: callback(),
        })
        // Every new consent pauses checkout until the operator selects this account's location.
        await ctx.setSetting("checkoutEnabled", false)
        await ctx.setSetting("locationId", "")
        await save(ctx.db, s, tokens)
        await createAudit(ctx.db).log({
          userId: actor.id,
          event: "square.connected",
          metadata: { merchantId: tokens.merchant_id, environment: s.environment },
        })
        return back("ok")
      } catch {
        return back("error")
      }
    }),
    del(
      "/connections/:id",
      admin(async c => {
        const row = await current(ctx.db)
        if (!row || row.id !== c.params.id) throw badRequest("This connection no longer exists")
        // Local disconnect never revokes another site's grant for the same Square application.
        await ctx.setSetting("checkoutEnabled", false)
        await ctx.db.execute(
          from("square_connections")
            .where(q => q("id").equals(row.id))
            .del(),
        )
        await createAudit(ctx.db).log({ userId: auth(c).id, event: "square.disconnected" })
        return json(c, 200, { data: { id: row.id } })
      }),
    ),
  ]
}
