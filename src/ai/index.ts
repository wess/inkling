import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import {
  badRequest,
  conflict,
  del,
  get,
  json,
  notFound,
  parseJson,
  pipe,
  pipeline,
  post,
  put,
  redirect,
} from "atlas/server"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { body, optionalText, requireText } from "../http/index.ts"
import { id } from "../ids/index.ts"
import { aiCredentials, users } from "../schema/index.ts"
import { now } from "../time/index.ts"
import type { ResolvedCredential } from "./complete.ts"
import { complete } from "./complete.ts"
import type { OAuthTokens } from "./oauth.ts"
import {
  authorizeUrl,
  clientFor,
  exchange,
  oauthReady,
  readState,
  redirectUri,
  refresh as refreshOauth,
} from "./oauth.ts"
import type { ProviderName } from "./providers.ts"
import { isProvider, PROVIDERS, providerCatalog } from "./providers.ts"
import { open, seal } from "./secrets.ts"

export type AiCredentialRow = {
  id: string
  provider: string
  label: string
  model: string
  base_url: string | null
  ciphertext: string
  iv: string
  hint: string
  is_default: number
  created_by: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
  revoked_at: string | null
  auth_kind: string
  refresh_ciphertext: string | null
  refresh_iv: string | null
  expires_at: string | null
  scope: string | null
  account: string | null
}

// `ciphertext` and `iv` are structurally absent here rather than deleted from a
// spread, so a future field can't be added to the row type and leak by default.
// The same rule covers `refresh_ciphertext` / `refresh_iv`.
const present = (row: AiCredentialRow) => ({
  id: row.id,
  provider: row.provider,
  label: row.label,
  model: row.model,
  baseUrl: row.base_url,
  hint: row.hint,
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
  authKind: row.auth_kind === "oauth" ? ("oauth" as const) : ("key" as const),
  account: row.account,
  expiresAt: row.expires_at,
  scope: row.scope,
})

// A query, not a call against a connection — the builder is standalone and the
// caller decides which connection runs it.
const activeCredentials = () =>
  from(aiCredentials)
    .where(q => q("revoked_at").isNull())
    .orderBy("is_default", "DESC")
    .orderBy("created_at", "ASC")

// The columns a token grant writes, sealed. Shared by the initial exchange and
// every refresh so the two can never drift into storing different shapes.
const tokenColumns = async (tokens: OAuthTokens): Promise<Record<string, unknown>> => {
  const access = await seal(tokens.accessToken)
  const refreshSealed = tokens.refreshToken ? await seal(tokens.refreshToken) : null
  return {
    ciphertext: access.ciphertext,
    iv: access.iv,
    hint: access.hint,
    refresh_ciphertext: refreshSealed?.ciphertext ?? null,
    refresh_iv: refreshSealed?.iv ?? null,
    expires_at: tokens.expiresAt,
    scope: tokens.scope,
    updated_at: now(),
  }
}

// An access token is refreshed a minute early rather than on expiry, because
// the request it is about to authorize takes non-zero time to arrive.
const REFRESH_MARGIN_MS = 60_000

const expiringSoon = (expiresAt: string | null): boolean =>
  expiresAt !== null && Date.parse(expiresAt) - Date.now() < REFRESH_MARGIN_MS

// Swaps an expiring OAuth token for a fresh one and writes it back. Returns the
// access token to use, or null when the connection can no longer be revived —
// a revoked grant and a rotated SECRET both land here, and both should read as
// "reconnect this provider" rather than as a failed completion.
const refreshed = async (db: Connection, row: AiCredentialRow, provider: ProviderName): Promise<string | null> => {
  const client = clientFor(provider)
  if (!client) return null
  if (!row.refresh_ciphertext || !row.refresh_iv) return null

  const refreshToken = await open({ ciphertext: row.refresh_ciphertext, iv: row.refresh_iv })
  if (!refreshToken) return null

  try {
    const tokens = await refreshOauth(client, refreshToken)
    await db.execute(
      from(aiCredentials)
        .update(await tokenColumns(tokens))
        .where(q => q("id").equals(row.id)),
    )
    return tokens.accessToken
  } catch {
    return null
  }
}

// The credential the assistant should use: the explicit default if one is set,
// otherwise the oldest surviving connection. Returns null when nothing is
// configured, which every caller treats as "the assistant is off" rather than as
// an error — a fresh install has no provider and that is a normal state.
export const resolveCredential = async (db: Connection): Promise<ResolvedCredential | null> => {
  const row = await db.one<AiCredentialRow>(activeCredentials())
  if (!row || !isProvider(row.provider)) return null

  const spec = PROVIDERS[row.provider]
  const oauth = row.auth_kind === "oauth"
  // A rotated SECRET leaves ciphertext that no longer opens. Treating that as
  // "not configured" surfaces in the UI as a provider to reconnect.
  const stored = spec.needsKey || oauth ? await open(row) : ""
  if ((spec.needsKey || oauth) && stored === null) return null

  const secret = oauth && expiringSoon(row.expires_at) ? await refreshed(db, row, row.provider) : stored
  if (secret === null) return null

  void db
    .execute(
      from(aiCredentials)
        .update({ last_used_at: now() })
        .where(q => q("id").equals(row.id)),
    )
    .catch(() => {})

  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    secret: secret ?? "",
    baseUrl: row.base_url,
    authKind: oauth ? "oauth" : "key",
  }
}

export const aiEnabled = async (db: Connection): Promise<boolean> => (await resolveCredential(db)) !== null

export const aiRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db), requireCan(can.manageAi, "manage AI providers"))
  const write = pipeline(requireAuth(db), requireCan(can.manageAi, "manage AI providers"), parseJson)
  const act = pipeline(requireAuth(db), requireCan(can.manageAi, "manage AI providers"))

  const parseModel = (provider: ProviderName, raw: unknown): string => {
    const spec = PROVIDERS[provider]
    const model = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : spec.defaultModel
    // Not restricted to the catalog: providers ship models faster than this list
    // is updated, and an operator naming a newer one shouldn't have to wait for a
    // release. Length is bounded so it can't become a dumping ground.
    if (model.length > 96) throw badRequest("Model name is too long", { code: "BAD_MODEL" })
    return model
  }

  const parseBaseUrl = (provider: ProviderName, raw: unknown): string | null => {
    const spec = PROVIDERS[provider]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) {
      if (spec.needsBaseUrl) throw badRequest(`${spec.label} needs a base URL`, { code: "BAD_BASE_URL" })
      return null
    }
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme")
      return parsed.toString().replace(/\/$/, "")
    } catch {
      throw badRequest("Base URL must be an absolute http(s) URL", { code: "BAD_BASE_URL" })
    }
  }

  // Exactly one default. Done as a separate statement inside the caller's
  // transaction rather than a partial unique index, which isn't portable.
  const clearDefaults = async (tx: Connection, exceptId: string) =>
    tx.execute(
      from(aiCredentials)
        .update({ is_default: 0 })
        .where(q => q("id").notEquals(exceptId)),
    )

  return [
    get(
      "/ai/providers",
      read(async c =>
        json(c, 200, {
          data: providerCatalog(oauthReady),
          // Shown next to the OAuth section so an operator registering a client
          // can copy the redirect URI rather than reconstruct it and get it
          // subtly wrong, which is the single most common way this flow fails.
          redirectUri: redirectUri(),
        }),
      ),
    ),

    get(
      "/ai/credentials",
      read(async c => {
        const rows = await db.all<AiCredentialRow>(from(aiCredentials).orderBy("created_at", "DESC"))
        return json(c, 200, { data: rows.map(present) })
      }),
    ),

    post(
      "/ai/credentials",
      write(async c => {
        const input = body(c)
        const providerName = requireText(input, "provider", "Provider")
        if (!isProvider(providerName)) throw badRequest("Unknown provider", { code: "BAD_PROVIDER" })
        const spec = PROVIDERS[providerName]

        const label = optionalText(input, "label") ?? spec.label
        const model = parseModel(providerName, input.model)
        const baseUrl = parseBaseUrl(providerName, input.baseUrl)

        const secret = spec.needsKey ? requireText(input, "key", `${spec.label} API key`) : ""
        if (spec.needsKey && secret.length < 8) throw badRequest("That key looks too short", { code: "BAD_KEY" })

        const sealed = await seal(secret)
        const timestamp = now()
        const row: AiCredentialRow = {
          id: id(),
          provider: providerName,
          label,
          model,
          base_url: baseUrl,
          ciphertext: sealed.ciphertext,
          iv: sealed.iv,
          hint: sealed.hint,
          is_default: 1,
          created_by: auth(c).id,
          created_at: timestamp,
          updated_at: timestamp,
          last_used_at: null,
          revoked_at: null,
          auth_kind: "key",
          refresh_ciphertext: null,
          refresh_iv: null,
          expires_at: null,
          scope: null,
          account: null,
        }

        // Newest connection becomes the default — an operator adding a provider
        // is expressing a preference, not archiving one.
        await db.transaction(async tx => {
          await tx.execute(from(aiCredentials).insert(row))
          await clearDefaults(tx, row.id)
        })

        return json(c, 201, present(row))
      }),
    ),

    put(
      "/ai/credentials/:id",
      write(async c => {
        const row = await db.one<AiCredentialRow>(from(aiCredentials).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Provider connection not found")
        if (row.revoked_at) throw badRequest("That connection has been removed", { code: "REVOKED" })
        if (!isProvider(row.provider)) throw badRequest("Unknown provider", { code: "BAD_PROVIDER" })

        const input = body(c)
        const changes: Record<string, unknown> = { updated_at: now() }
        if (input.label !== undefined) changes.label = requireText(input, "label", "Label")
        if (input.model !== undefined) changes.model = parseModel(row.provider, input.model)
        if (input.baseUrl !== undefined) changes.base_url = parseBaseUrl(row.provider, input.baseUrl)

        // Replacing the key is an update; reading it back never is.
        if (input.key !== undefined) {
          if (row.auth_kind === "oauth") {
            throw badRequest("This connection is authorized by OAuth — reconnect it instead of pasting a key", {
              code: "OAUTH_CONNECTION",
            })
          }
          const secret = requireText(input, "key", "API key")
          const sealed = await seal(secret)
          changes.ciphertext = sealed.ciphertext
          changes.iv = sealed.iv
          changes.hint = sealed.hint
        }

        const makeDefault = input.isDefault === true

        await db.transaction(async tx => {
          await tx.execute(
            from(aiCredentials)
              .update(makeDefault ? { ...changes, is_default: 1 } : changes)
              .where(q => q("id").equals(row.id)),
          )
          if (makeDefault) await clearDefaults(tx, row.id)
        })

        const updated = await db.one<AiCredentialRow>(from(aiCredentials).where(q => q("id").equals(row.id)))
        return json(c, 200, present(updated as AiCredentialRow))
      }),
    ),

    del(
      "/ai/credentials/:id",
      act(async c => {
        const row = await db.one<AiCredentialRow>(from(aiCredentials).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Provider connection not found")

        // Hard delete rather than a soft one: the row's only real content is a
        // secret, and keeping ciphertext around after an operator asked for it to
        // be gone is the wrong default.
        await db.execute(
          from(aiCredentials)
            .where(q => q("id").equals(row.id))
            .del(),
        )

        // Promote whatever is left so the assistant keeps working.
        const next = await db.one<AiCredentialRow>(activeCredentials())
        if (next) {
          await db.execute(
            from(aiCredentials)
              .update({ is_default: 1 })
              .where(q => q("id").equals(next.id)),
          )
        }

        return json(c, 200, { deleted: true, id: row.id })
      }),
    ),

    // Hands back a URL rather than a redirect: the caller is the admin's fetch
    // client, which cannot follow a cross-origin redirect into a consent screen.
    // The SPA navigates the tab to it.
    post(
      "/ai/oauth/:provider/start",
      act(async c => {
        const providerName = c.params.provider ?? ""
        if (!isProvider(providerName)) throw badRequest("Unknown provider", { code: "BAD_PROVIDER" })

        const client = clientFor(providerName)
        if (!client) {
          throw conflict(
            `No OAuth client is configured for ${PROVIDERS[providerName].label}. Register one with the provider and set AI_OAUTH_${providerName.toUpperCase()}_CLIENT_ID.`,
            { code: "NO_OAUTH_CLIENT" },
          )
        }

        const started = await authorizeUrl(client, auth(c).id)
        return json(c, 200, { url: started.url, expiresAt: started.expiresAt })
      }),
    ),

    // Round-trips one cheap request so an operator finds out the key is wrong
    // here, rather than the first time an author asks for a draft.
    post(
      "/ai/credentials/:id/test",
      act(async c => {
        const row = await db.one<AiCredentialRow>(from(aiCredentials).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Provider connection not found")
        if (!isProvider(row.provider)) throw badRequest("Unknown provider", { code: "BAD_PROVIDER" })

        const spec = PROVIDERS[row.provider]
        const oauth = row.auth_kind === "oauth"
        const stored = spec.needsKey || oauth ? await open(row) : ""
        if ((spec.needsKey || oauth) && stored === null) {
          throw conflict(
            oauth
              ? "This connection can no longer be decrypted — reconnect the provider"
              : "This connection can no longer be decrypted — re-enter its key",
            { code: "SEALED" },
          )
        }

        // Testing an expiring grant should exercise a token the provider will
        // still accept, so the refresh happens here too rather than only on the
        // path the assistant takes.
        const secret = oauth && expiringSoon(row.expires_at) ? await refreshed(db, row, row.provider) : stored
        if (secret === null) {
          throw conflict("This connection could not be refreshed — reconnect the provider", { code: "EXPIRED" })
        }

        const credential: ResolvedCredential = {
          id: row.id,
          provider: row.provider,
          model: row.model,
          secret: secret ?? "",
          baseUrl: row.base_url,
          authKind: oauth ? "oauth" : "key",
        }

        try {
          const result = await complete(credential, {
            system: "Reply with the single word OK.",
            prompt: "Reply with the single word OK.",
            maxTokens: 16,
          })
          return json(c, 200, {
            ok: !result.refused && result.text.trim() !== "",
            provider: result.provider,
            model: result.model,
            refused: result.refused,
          })
        } catch (error) {
          // The provider's message is the useful part (bad key, no quota, host
          // unreachable) and contains no secret, so it is passed through.
          return json(c, 200, { ok: false, provider: row.provider, model: row.model, error: (error as Error).message })
        }
      }),
    ),
  ]
}

// Public, because the browser arrives here by top-level navigation from the
// provider and carries no bearer token. What stands in for a session is the
// sealed `state`: it names the admin who started the flow, expires in ten
// minutes, and cannot be minted without SECRET. The role is re-read on the way
// through, so an account demoted mid-flow does not get to finish it.
export const aiPublicRoutes = (db: Connection, adminBase: string): Route[] => {
  const admin = adminBase === "/" ? "" : adminBase.replace(/\/$/, "")

  // Everything lands back on the AI screen with a readable outcome rather than
  // on a bare JSON error, because the person reading it is in a browser tab
  // they were redirected into and has no other way back.
  const back = (c: Parameters<typeof redirect>[0], outcome: string, detail?: string) =>
    redirect(
      c,
      `${admin}/ai?connected=${encodeURIComponent(outcome)}${detail ? `&reason=${encodeURIComponent(detail.slice(0, 300))}` : ""}`,
    )

  return [
    get(
      "/ai/oauth/callback",
      pipe(async c => {
        const denied = typeof c.query.error === "string" ? c.query.error : ""
        if (denied) return back(c, "error", c.query.error_description ?? denied)

        const pending = await readState(typeof c.query.state === "string" ? c.query.state : "")
        if (!pending) return back(c, "error", "That sign-in link expired or was not issued by this site")

        const code = typeof c.query.code === "string" ? c.query.code : ""
        if (!code) return back(c, "error", "The provider returned no authorization code")

        const client = clientFor(pending.provider)
        if (!client) return back(c, "error", "The OAuth client for that provider is no longer configured")

        const actor = await db.one<{ id: string; role: string; deleted_at: string | null }>(
          from(users).where(q => q("id").equals(pending.userId)),
        )
        if (!actor || actor.deleted_at || !can.manageAi(actor.role)) {
          return back(c, "error", "That account may no longer manage AI providers")
        }

        let tokens: OAuthTokens
        try {
          tokens = await exchange(client, code, pending.verifier)
        } catch (error) {
          return back(c, "error", (error as Error).message)
        }

        const spec = PROVIDERS[pending.provider]
        const timestamp = now()
        const sealedColumns = await tokenColumns(tokens)

        await db.transaction(async tx => {
          // Reconnecting replaces rather than stacks. Two OAuth rows for the
          // same provider and account are the same grant twice, and the older
          // one holds a refresh token the provider may already have rotated.
          await tx.execute(
            from(aiCredentials)
              .where(q => q("provider").equals(pending.provider))
              .where(q => q("auth_kind").equals("oauth"))
              .del(),
          )

          const row = {
            id: id(),
            provider: pending.provider,
            label: tokens.account ? `${spec.label} — ${tokens.account}` : spec.label,
            model: spec.defaultModel,
            base_url: null,
            is_default: 1,
            created_by: actor.id,
            created_at: timestamp,
            last_used_at: null,
            revoked_at: null,
            auth_kind: "oauth",
            account: tokens.account,
            ...sealedColumns,
          }

          await tx.execute(from(aiCredentials).insert(row))
          await tx.execute(
            from(aiCredentials)
              .update({ is_default: 0 })
              .where(q => q("id").notEquals(row.id as string)),
          )
        })

        return back(c, "ok")
      }),
    ),
  ]
}

export type { Completion, CompletionRequest, ResolvedCredential } from "./complete.ts"
export { complete, completeStream } from "./complete.ts"
