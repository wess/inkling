import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { open, seal } from "../ai/secrets.ts"
import { one, rows as query } from "../db/dialect.ts"
import { fromBit, toBit } from "../json/index.ts"
import type { OAuthClient } from "../oauth/index.ts"
import { socialApps } from "../schema/index.ts"
import { now } from "../time/index.ts"
import type { Network } from "./networks.ts"
import { networkFor } from "./networks.ts"

// Which networks this install has a developer app for, and what that app is.
//
// Two sources, in one order. A row in `social_apps` is what the admin wrote and
// wins; the `SOCIAL_OAUTH_<NETWORK>_*` environment variables are the fallback,
// so an install configured before there was a screen keeps working and can be
// migrated one network at a time by saving over it.
//
// Only `clientFor` knows there are two. Everything else asks it.

export type AppRow = {
  network: string
  enabled: number
  client_id: string
  secret_ct: string | null
  secret_iv: string | null
  secret_hint: string | null
  authorize_url: string | null
  token_url: string | null
  scopes: string | null
  updated_by: string | null
  updated_at: string
}

export type AppView = {
  readonly network: string
  readonly enabled: boolean
  readonly clientId: string
  // The last four characters of the secret, never the secret. Enough to tell
  // two apart against a developer console, and useless to anyone else.
  readonly secretHint: string | null
  readonly hasSecret: boolean
  readonly authorizeUrl: string | null
  readonly tokenUrl: string | null
  readonly scopes: string | null
  readonly updatedAt: string
  // Whether the credentials came from a row here or from the environment. The
  // screen says so, because "why can I not edit this" has exactly one answer.
  readonly source: "admin" | "environment" | "none"
}

const environment = (name: string): string => (typeof Bun !== "undefined" ? Bun.env[name] : process.env[name]) ?? ""

const listOf = (value: string): readonly string[] =>
  value
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(Boolean)

const envClient = (
  network: string,
): {
  clientId: string
  clientSecret: string
  authorizeUrl: string
  tokenUrl: string
  scopes: readonly string[]
} | null => {
  const prefix = `SOCIAL_OAUTH_${network.toUpperCase()}`
  const clientId = environment(`${prefix}_CLIENT_ID`)
  if (!clientId) return null
  return {
    clientId,
    clientSecret: environment(`${prefix}_CLIENT_SECRET`),
    authorizeUrl: environment(`${prefix}_AUTHORIZE_URL`),
    tokenUrl: environment(`${prefix}_TOKEN_URL`),
    scopes: listOf(environment(`${prefix}_SCOPES`)),
  }
}

export const list = (db: Connection): Promise<AppRow[]> =>
  query<AppRow>(db, from("social_apps", "a").orderBy("a.network", "ASC"))

export const byNetwork = (db: Connection, network: string): Promise<AppRow | null> =>
  one<AppRow>(
    db,
    from("social_apps", "a").where(q => q("a.network").equals(network)),
  )

export const present = (network: string, row: AppRow | null): AppView => {
  if (row?.client_id) {
    return {
      network,
      enabled: fromBit(row.enabled),
      clientId: row.client_id,
      secretHint: row.secret_hint,
      hasSecret: row.secret_ct !== null,
      authorizeUrl: row.authorize_url,
      tokenUrl: row.token_url,
      scopes: row.scopes,
      updatedAt: row.updated_at,
      source: "admin",
    }
  }

  const fallback = envClient(network)
  if (fallback) {
    return {
      network,
      enabled: true,
      clientId: fallback.clientId,
      secretHint: fallback.clientSecret ? `••••${fallback.clientSecret.slice(-4)}` : null,
      hasSecret: fallback.clientSecret !== "",
      authorizeUrl: fallback.authorizeUrl || null,
      tokenUrl: fallback.tokenUrl || null,
      scopes: fallback.scopes.length > 0 ? fallback.scopes.join(", ") : null,
      updatedAt: "",
      source: "environment",
    }
  }

  return {
    network,
    enabled: row ? fromBit(row.enabled) : false,
    clientId: "",
    secretHint: null,
    hasSecret: false,
    authorizeUrl: null,
    tokenUrl: null,
    scopes: null,
    updatedAt: row?.updated_at ?? "",
    source: "none",
  }
}

export type AppInput = {
  readonly enabled: boolean
  readonly clientId: string
  // Absent means "keep what is stored". An empty string means "clear it" — the
  // two have to be distinguishable, or a form that never echoes the secret back
  // would wipe it on every save of any other field.
  readonly clientSecret?: string
  readonly authorizeUrl: string | null
  readonly tokenUrl: string | null
  readonly scopes: string | null
}

export const save = async (
  db: Connection,
  network: string,
  input: AppInput,
  userId: string | null,
): Promise<AppRow> => {
  const existing = await byNetwork(db, network)
  const sealed =
    input.clientSecret === undefined
      ? null
      : input.clientSecret === ""
        ? { ciphertext: null, iv: null, hint: null }
        : await seal(input.clientSecret)

  const fields = {
    enabled: toBit(input.enabled),
    client_id: input.clientId,
    ...(sealed === null ? {} : { secret_ct: sealed.ciphertext, secret_iv: sealed.iv, secret_hint: sealed.hint }),
    authorize_url: input.authorizeUrl,
    token_url: input.tokenUrl,
    scopes: input.scopes,
    updated_by: userId,
    updated_at: now(),
  }

  if (existing) {
    await db.execute(
      from(socialApps)
        .update(fields)
        .where(q => q("network").equals(network)),
    )
    return { ...existing, ...fields }
  }

  const row: AppRow = {
    network,
    secret_ct: null,
    secret_iv: null,
    secret_hint: null,
    ...fields,
  }
  await db.execute(from(socialApps).insert(row))
  return row
}

export const remove = async (db: Connection, network: string): Promise<void> => {
  await db.execute(
    from(socialApps)
      .where(q => q("network").equals(network))
      .del(),
  )
}

// TikTok's v2 endpoints call the client id `client_key`, want scopes separated
// by commas, and reject the request when the credentials also ride in an
// Authorization header that X requires. All three are spelling rather than
// behaviour, which is why they are said here and not in src/oauth.
const quirks = (network: string): Partial<OAuthClient> =>
  network === "tiktok" ? { clientParam: "client_key", scopeSeparator: ",", basicAuth: false } : {}

const build = (
  spec: Network,
  clientId: string,
  clientSecret: string,
  authorizeUrl: string | null,
  tokenUrl: string | null,
  scopes: readonly string[],
): OAuthClient => ({
  clientId,
  clientSecret,
  authorizeUrl: authorizeUrl || spec.oauth.authorizeUrl,
  tokenUrl: tokenUrl || spec.oauth.tokenUrl,
  scopes: scopes.length > 0 ? scopes : spec.oauth.scopes,
  ...quirks(spec.value),
})

// The one door. Returns null when a network has no app, or has one that is
// switched off — both of which read on screen as "not offered" rather than as a
// button that dead-ends.
export const clientFor = async (db: Connection, network: string): Promise<OAuthClient | null> => {
  const spec = networkFor(network)
  if (!spec) return null

  const row = await byNetwork(db, network)
  if (row?.client_id) {
    if (!fromBit(row.enabled)) return null
    const secret = row.secret_ct && row.secret_iv ? await open({ ciphertext: row.secret_ct, iv: row.secret_iv }) : null
    return build(spec, row.client_id, secret ?? "", row.authorize_url, row.token_url, listOf(row.scopes ?? ""))
  }

  // A row with no client id is a network someone switched off before ever
  // setting it up. It still means "off".
  if (row && !fromBit(row.enabled)) return null

  const fallback = envClient(network)
  if (!fallback) return null
  return build(
    spec,
    fallback.clientId,
    fallback.clientSecret,
    fallback.authorizeUrl,
    fallback.tokenUrl,
    fallback.scopes,
  )
}

export const ready = async (db: Connection, network: string): Promise<boolean> =>
  (await clientFor(db, network)) !== null
