import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import { badRequest, del, get, json, notFound, parseJson, pipeline, post, put, redirect } from "atlas/server"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { config } from "../config/index.ts"
import { countRows, rows as query } from "../db/dialect.ts"
import { body, bool, optionalText, text } from "../http/index.ts"
import { consentUrl, exchange as exchangeCode, readState } from "../oauth/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { users } from "../schema/index.ts"
import type { StorageDriver } from "../storage/index.ts"
import { now, parseIso } from "../time/index.ts"
import {
  byId as accountById,
  list as listAccounts,
  present as presentAccount,
  remove as removeAccount,
  save as saveAccount,
} from "./accounts.ts"
import {
  byNetwork as appFor,
  clientFor,
  ready as networkReady,
  present as presentApp,
  remove as removeApp,
  save as saveApp,
} from "./apps.ts"
import { guideFor, PREAMBLE } from "./guides.ts"
import { NETWORKS, networkFor, networkLabel } from "./networks.ts"
import { identify, redirectUri } from "./oauth.ts"
import type { PostInput, PostRow } from "./posts.ts"
import {
  create as createPost,
  list as listPosts,
  byId as postById,
  present,
  readInput,
  remove as removePost,
  setStatus,
  targetsFor,
  timeline,
  update as updatePost,
} from "./posts.ts"
import { claim, send } from "./publish.ts"

// The Social section's HTTP surface. Two audiences and therefore two arrays:
// everything below `socialRoutes` needs a session and is mounted under /api,
// and `socialPublicRoutes` is the single OAuth return leg, which arrives by
// top-level navigation from a network and carries no bearer token.

// What rides through the network and back in the sealed `state`.
type Pending = { readonly network: string; readonly userId: string }

const hydrate = async (db: Connection, posts: readonly PostRow[]) => {
  if (posts.length === 0) return []
  const [targets, accounts] = await Promise.all([
    targetsFor(
      db,
      posts.map(post => post.id),
    ),
    listAccounts(db),
  ])
  const byId = new Map(accounts.map(account => [account.id, account]))
  return posts.map(post => present(post, targets, byId))
}

const load = async (db: Connection, id: string): Promise<PostRow> => {
  const row = await postById(db, id)
  if (!row) throw notFound("That post no longer exists")
  return row
}

const one = async (db: Connection, row: PostRow) => (await hydrate(db, [row]))[0]

const days = (value: unknown, fallback: number, ceiling: number): number =>
  Math.min(Math.max(Number(value) || fallback, 1), ceiling)

// Writing a post and deciding it goes out are two permissions, so a save from
// an author cannot move the send time — it keeps whatever an editor set, or
// none. Enforced here rather than in `posts.ts` because it is a question about
// who is asking, and that is a property of the request.
const schedulable = (c: { assigns: Record<string, unknown> }, input: PostInput, current: string | null): PostInput =>
  can.publishSocial((c.assigns.auth as { role: string }).role) ? input : { ...input, scheduledAt: current }

export const socialRoutes = (db: Connection, store: StorageDriver, hooks: Hooks): Route[] => {
  const write = requireCan(can.writeSocial, "write social posts")
  const publish = requireCan(can.publishSocial, "send social posts")
  const connect = requireCan(can.manageSocial, "connect social accounts")

  const composing = pipeline(requireAuth(db), write)
  const composingJson = pipeline(requireAuth(db), write, parseJson)
  const sending = pipeline(requireAuth(db), publish)
  const sendingJson = pipeline(requireAuth(db), publish, parseJson)
  const connecting = pipeline(requireAuth(db), connect)
  const connectingJson = pipeline(requireAuth(db), connect, parseJson)

  // Which networks are set up, resolved once per request that needs it. Every
  // answer is a decrypt, so this is not free and not worth doing per network in
  // three different handlers.
  const readiness = async (): Promise<Set<string>> => {
    const live = await Promise.all(
      NETWORKS.map(async network => ((await networkReady(db, network.value)) ? network.value : "")),
    )
    return new Set(live.filter(Boolean))
  }

  return [
    // What the composer needs to draw itself: every network Inkling can post
    // to, whether this install has an app registered for it, and which accounts
    // are live. One request rather than three, because none of it is useful
    // without the rest.
    get(
      "/social/networks",
      composing(async c => {
        const [accounts, live] = await Promise.all([listAccounts(db), readiness()])
        return json(c, 200, {
          data: {
            redirectUri: redirectUri(),
            networks: NETWORKS.map(network => ({
              value: network.value,
              label: network.label,
              limit: network.limit,
              media: network.media,
              options: network.options,
              help: network.help,
              configured: live.has(network.value),
              accounts: accounts.filter(account => account.network === network.value).map(presentAccount),
            })),
          },
        })
      }),
    ),

    // The dashboard. Counts by status, what goes out next, what went out last,
    // and every connection that needs attention — the four things somebody
    // opening this section on a Monday is actually checking.
    get(
      "/social/overview",
      composing(async c => {
        const counting = (status: string) =>
          countRows(
            db,
            from("social_posts", "p")
              .select("COUNT(*) as total")
              .where(q => q("p.deleted_at").isNull())
              .where(q => q("p.status").equals(status)),
          )

        const [drafts, scheduled, posted, partial, failed, accounts] = await Promise.all([
          counting("draft"),
          counting("scheduled"),
          counting("posted"),
          counting("partial"),
          counting("failed"),
          listAccounts(db),
        ])

        const upcoming = await query<PostRow>(
          db,
          from("social_posts", "p")
            .where(q => q("p.deleted_at").isNull())
            .where(q => q("p.status").equals("scheduled"))
            .orderBy("p.scheduled_at", "ASC")
            .limit(8),
        )

        const recent = await query<PostRow>(
          db,
          from("social_posts", "p")
            .where(q => q("p.deleted_at").isNull())
            .where(q => q("p.status").inList(["posted", "partial", "failed"]))
            .orderBy("p.updated_at", "DESC")
            .limit(8),
        )

        const live = await readiness()

        return json(c, 200, {
          data: {
            counts: { drafts, scheduled, posted, partial, failed },
            upcoming: await hydrate(db, upcoming),
            recent: await hydrate(db, recent),
            accounts: accounts.map(presentAccount),
            // A network set up but not connected is the most common reason the
            // composer looks empty, and the dashboard is where someone notices.
            connectable: NETWORKS.filter(
              network => live.has(network.value) && !accounts.some(account => account.network === network.value),
            ).map(network => ({ value: network.value, label: network.label })),
            // And a network with no app at all is a different problem with a
            // different screen, so it is counted rather than listed.
            unconfigured: NETWORKS.filter(network => !live.has(network.value)).length,
          },
        })
      }),
    ),

    get(
      "/social/posts",
      composing(async c => {
        const { posts, total, limit, page } = await listPosts(db, c.query as Record<string, string>)
        return json(c, 200, { data: await hydrate(db, posts), meta: { total, page, limit } })
      }),
    ),

    get(
      "/social/posts/:id",
      composing(async c => json(c, 200, await one(db, await load(db, String(c.params.id ?? ""))))),
    ),

    post(
      "/social/posts",
      composingJson(async c => {
        const row = await createPost(db, store, schedulable(c, readInput(body(c)), null), auth(c).id)
        return json(c, 201, await one(db, row))
      }),
    ),

    put(
      "/social/posts/:id",
      composingJson(async c => {
        const existing = await load(db, String(c.params.id ?? ""))
        const input = schedulable(c, readInput(body(c)), existing.scheduled_at)
        return json(c, 200, await one(db, await updatePost(db, store, existing, input)))
      }),
    ),

    del(
      "/social/posts/:id",
      composing(async c => {
        const row = await load(db, String(c.params.id ?? ""))
        if (row.status === "publishing") throw badRequest("This post is going out right now", { code: "SOCIAL_BUSY" })
        await removePost(db, row.id)
        return json(c, 200, { deleted: true, id: row.id })
      }),
    ),

    // Scheduling is separate from saving because it is a different permission.
    // An author writes the post; an editor decides it goes out.
    post(
      "/social/posts/:id/schedule",
      sendingJson(async c => {
        const row = await load(db, String(c.params.id ?? ""))
        const at = parseIso(body(c).at)
        if (!at) throw badRequest("A scheduled post needs a date and time", { code: "MISSING" })
        if (at <= now()) throw badRequest("That time has already passed", { code: "SOCIAL_PAST" })
        if (row.status === "publishing") throw badRequest("This post is going out right now", { code: "SOCIAL_BUSY" })

        await db.execute(
          from("social_posts")
            .update({ status: "scheduled", scheduled_at: at, updated_at: now() })
            .where(q => q("id").equals(row.id)),
        )
        return json(c, 200, await one(db, { ...row, status: "scheduled", scheduled_at: at }))
      }),
    ),

    // Sending by hand, and the same call for retrying the networks that
    // refused: `send` skips every target already posted, so pressing this twice
    // does not post twice.
    post(
      "/social/posts/:id/publish",
      sending(async c => {
        const row = await load(db, String(c.params.id ?? ""))
        const claimed = await claim(db, row.id, ["draft", "scheduled", "posted", "partial", "failed"])
        if (!claimed) throw badRequest("This post is already going out", { code: "SOCIAL_BUSY" })

        const outcome = await send(db, store, claimed, hooks)
        return json(c, 200, { data: outcome, post: await one(db, await load(db, row.id)) })
      }),
    ),

    post(
      "/social/posts/:id/cancel",
      sending(async c => {
        const row = await load(db, String(c.params.id ?? ""))
        if (row.status !== "scheduled")
          throw badRequest("Only a scheduled post can be called back", { code: "SOCIAL_STATE" })
        await setStatus(db, row.id, "draft")
        return json(c, 200, await one(db, await load(db, row.id)))
      }),
    ),

    // The calendar's data, unrendered. `from` is whatever the browser's grid
    // starts at, so the server does no timezone arithmetic — the admin knows
    // the operator's zone and the database only ever holds UTC.
    get(
      "/social/calendar",
      composing(async c => {
        const start = parseIso(c.query.from) ?? new Date().toISOString()
        const span = days(c.query.days, 30, 120)
        const end = new Date(Date.parse(start) + span * 86_400_000).toISOString()
        return json(c, 200, { data: await hydrate(db, await timeline(db, start, end)) })
      }),
    ),

    // ------------------------------------------------------------- settings

    // The developer app per network: what is set up, what it came from, and
    // what the operator still has to do at that network's end. The secret is
    // never in this payload — only the last four characters of it.
    get(
      "/social/settings",
      connecting(async c => {
        const live = await readiness()
        const networks = await Promise.all(
          NETWORKS.map(async network => ({
            value: network.value,
            label: network.label,
            help: network.help,
            console: network.console,
            scopes: network.oauth.scopes,
            defaults: { authorizeUrl: network.oauth.authorizeUrl, tokenUrl: network.oauth.tokenUrl },
            fetchesMedia: network.fetchesMedia,
            ready: live.has(network.value),
            app: presentApp(network.value, await appFor(db, network.value)),
            // The step-by-step for getting these two values out of that
            // network's console. Shipped with the payload rather than built
            // into the bundle so it can be corrected when a console moves,
            // which they do, without a release of the admin.
            guide: guideFor(network.value),
          })),
        )

        return json(c, 200, {
          data: {
            redirectUri: redirectUri(),
            // Said once, at the top of the screen, because it is the same
            // string for all nine and every one of them fails the same way
            // when it does not match.
            publicUrl: config.publicUrl,
            preamble: PREAMBLE,
            networks,
          },
        })
      }),
    ),

    put(
      "/social/settings/:network",
      connectingJson(async c => {
        const network = String(c.params.network ?? "")
        if (!networkFor(network)) throw notFound("That is not a network Inkling can post to")

        const payload = body(c)
        const clientId = text(payload, "clientId").trim()
        const enabled = bool(payload, "enabled", true)

        if (enabled && clientId === "") {
          throw badRequest(`${networkLabel(network)} needs a client id before it can be switched on`, {
            code: "MISSING",
            details: { fields: [{ key: "clientId", message: "Required" }] },
          })
        }

        await saveApp(
          db,
          network,
          {
            enabled,
            clientId,
            // Absent means "keep what is stored" — the form never echoes the
            // secret back, so treating a missing field as empty would wipe it
            // every time any other field was saved.
            ...(payload.clientSecret === undefined ? {} : { clientSecret: String(payload.clientSecret) }),
            authorizeUrl: optionalText(payload, "authorizeUrl"),
            tokenUrl: optionalText(payload, "tokenUrl"),
            scopes: optionalText(payload, "scopes"),
          },
          auth(c).id,
        )

        return json(c, 200, { data: presentApp(network, await appFor(db, network)) })
      }),
    ),

    // Forgets the credentials without touching the accounts already authorized
    // with them. Those keep working until their tokens lapse, which is the
    // honest behaviour — the network does not know we deleted anything.
    del(
      "/social/settings/:network",
      connecting(async c => {
        const network = String(c.params.network ?? "")
        await removeApp(db, network)
        return json(c, 200, { data: presentApp(network, await appFor(db, network)) })
      }),
    ),

    // ------------------------------------------------------------- accounts

    get(
      "/social/accounts",
      connecting(async c => {
        const live = await readiness()
        return json(c, 200, {
          data: {
            redirectUri: redirectUri(),
            networks: NETWORKS.map(network => ({
              value: network.value,
              label: network.label,
              help: network.help,
              scopes: network.oauth.scopes,
              configured: live.has(network.value),
            })),
            accounts: (await listAccounts(db)).map(presentAccount),
          },
        })
      }),
    ),

    // Returns the consent URL rather than redirecting: the caller is the admin
    // on a fetch, and a 302 to a third party would be followed by the fetch
    // rather than by the browser's address bar.
    post(
      "/social/accounts/:network/start",
      connecting(async c => {
        const network = String(c.params.network ?? "")
        const client = await clientFor(db, network)
        if (!client) {
          throw badRequest(`${networkLabel(network)} is not set up yet. Add its developer app under Social settings.`, {
            code: "NO_OAUTH_CLIENT",
          })
        }

        const spec = NETWORKS.find(item => item.value === network)
        const { url, expiresAt } = await consentUrl<Pending>(
          client,
          redirectUri(),
          { network, userId: auth(c).id },
          spec?.oauth.extra ?? {},
        )
        return json(c, 200, { data: { url, expiresAt } })
      }),
    ),

    del(
      "/social/accounts/:id",
      connecting(async c => {
        const row = await accountById(db, String(c.params.id ?? ""))
        if (!row) throw notFound("That connection no longer exists")
        await removeAccount(db, row.id)
        return json(c, 200, { data: { id: row.id } })
      }),
    ),
  ]
}

// Public, because the browser arrives here by top-level navigation from the
// network and carries no bearer token for a fetch to attach. What stands in for
// a session is the sealed `state`: it names the admin who started the flow,
// expires in ten minutes, and cannot be minted without SECRET. The capability is
// re-read on the way through, so an account demoted mid-flow cannot finish it.
export const socialPublicRoutes = (db: Connection, adminBase: string): Route[] => [
  get("/social/oauth/callback", async c => {
    const home = adminBase === "/" ? "" : adminBase
    const back = (outcome: string, detail?: string) =>
      redirect(
        c,
        `${home}/social/accounts?connected=${encodeURIComponent(outcome)}` +
          (detail ? `&reason=${encodeURIComponent(detail.slice(0, 300))}` : ""),
      )

    const denied = typeof c.query.error === "string" ? c.query.error : ""
    if (denied) return back("error", String(c.query.error_description ?? denied))

    const pending = await readState<Pending>(typeof c.query.state === "string" ? c.query.state : "")
    if (!pending || typeof pending.network !== "string") {
      return back("error", "That connection link expired or was not issued by this site")
    }

    const code = typeof c.query.code === "string" ? c.query.code : ""
    if (!code) return back("error", `${networkLabel(pending.network)} returned no authorization code`)

    const client = await clientFor(db, pending.network)
    if (!client) return back("error", "That network's developer app is no longer set up, or was switched off")

    const actor = await db.one<{ id: string; role: string; deleted_at: string | null }>(
      from(users).where(q => q("id").equals(pending.userId)),
    )
    if (!actor || actor.deleted_at || !can.manageSocial(actor.role)) {
      return back("error", "That account may no longer connect social accounts")
    }

    try {
      const tokens = await exchangeCode(client, redirectUri(), code, pending.verifier)
      // Identifying is also where Facebook's user token becomes a Page token,
      // so it happens before anything is stored — a connection saved with the
      // wrong token would look connected and fail on its first post.
      const identified = await identify(pending.network, client, tokens)
      await saveAccount(db, {
        network: pending.network,
        account: identified.name,
        accountId: identified.remoteId,
        meta: identified.meta,
        userId: actor.id,
        tokens: identified.tokens,
      })
      return back("ok", identified.name ?? networkLabel(pending.network))
    } catch (error) {
      return back("error", error instanceof Error ? error.message : "The network refused the connection")
    }
  }),
]
