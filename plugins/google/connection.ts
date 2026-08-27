import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { open, seal } from "../../src/ai/secrets.ts"
import { one } from "../../src/db/dialect.ts"
import { id as newId } from "../../src/ids/index.ts"
import { encode } from "../../src/json/index.ts"
import type { OAuthClient, OAuthTokens } from "../../src/oauth/index.ts"
import { refresh } from "../../src/oauth/index.ts"
import { now } from "../../src/time/index.ts"

// The one Google account this site is connected to, and the only place a token
// is turned back into something usable. Everything above this file holds an
// access token for the length of one fetch and never a stored one.

const TABLE = "google_connections"

// A token about to expire is renewed before it is handed out, rather than after
// something fails with it. Ten minutes is generous for a report that takes two
// seconds, and the generosity is the point: a dashboard that intermittently
// 401s is diagnosed as "Google is flaky" for weeks.
const EARLY_MS = 10 * 60 * 1000

export type ConnectionRow = {
  id: string
  client_id: string
  account: string | null
  scope: string | null
  access_ct: string
  access_iv: string
  refresh_ct: string | null
  refresh_iv: string | null
  expires_at: string | null
  error: string | null
  connected_by: string | null
  connected_at: string
  updated_at: string
  meta: string | null
}

export const current = (db: Connection): Promise<ConnectionRow | null> =>
  one<ConnectionRow>(db, from(TABLE, "g").orderBy("g.connected_at", "DESC"))

export const byId = (db: Connection, id: string): Promise<ConnectionRow | null> =>
  one<ConnectionRow>(
    db,
    from(TABLE, "g").where(q => q("g.id").equals(id)),
  )

export const remove = async (db: Connection, id: string): Promise<void> => {
  await db.execute(
    from(TABLE)
      .where(q => q("id").equals(id))
      .del(),
  )
}

// Connecting and reconnecting are the same write. Somebody who authorizes again
// means "use this one instead", never "keep both" — and keeping both would mean
// every report had to ask which account it was for.
export const save = async (
  db: Connection,
  input: {
    readonly clientId: string
    readonly account: string | null
    readonly userId: string | null
    readonly meta?: Record<string, unknown>
    readonly tokens: OAuthTokens
  },
): Promise<ConnectionRow> => {
  const access = await seal(input.tokens.accessToken)
  const renewal = input.tokens.refreshToken ? await seal(input.tokens.refreshToken) : null
  const stamp = now()
  const existing = await current(db)

  const fields = {
    client_id: input.clientId,
    account: input.account,
    scope: input.tokens.scope,
    access_ct: access.ciphertext,
    access_iv: access.iv,
    refresh_ct: renewal?.ciphertext ?? null,
    refresh_iv: renewal?.iv ?? null,
    expires_at: input.tokens.expiresAt,
    error: null,
    meta: encode(input.meta ?? {}),
    updated_at: stamp,
  }

  if (existing) {
    await db.execute(
      from(TABLE)
        .update(fields)
        .where(q => q("id").equals(existing.id)),
    )
    return { ...existing, ...fields }
  }

  const row: ConnectionRow = {
    id: newId(),
    connected_by: input.userId,
    connected_at: stamp,
    ...fields,
  }
  await db.execute(from(TABLE).insert(row))
  return row
}

const flag = async (db: Connection, id: string, message: string | null): Promise<void> => {
  await db.execute(
    from(TABLE)
      .update({ error: message, updated_at: now() })
      .where(q => q("id").equals(id)),
  )
}

// Rewrites only the tokens, leaving who and what alone. A refresh is not a
// reconnection and must not clear the account name or the discovered metadata.
const restamp = async (db: Connection, row: ConnectionRow, tokens: OAuthTokens): Promise<void> => {
  const access = await seal(tokens.accessToken)
  const renewal = tokens.refreshToken ? await seal(tokens.refreshToken) : null

  await db.execute(
    from(TABLE)
      .update({
        access_ct: access.ciphertext,
        access_iv: access.iv,
        ...(renewal ? { refresh_ct: renewal.ciphertext, refresh_iv: renewal.iv } : {}),
        expires_at: tokens.expiresAt,
        scope: tokens.scope ?? row.scope,
        error: null,
        updated_at: now(),
      })
      .where(q => q("id").equals(row.id)),
  )
}

// The only way to get a usable token, and it returns null rather than throwing.
// A connection that cannot be renewed is a thing for a screen to explain — the
// panel that wanted last month's clicks has nothing useful to do with an
// exception about OAuth, and every caller here degrades to "not connected".
export const accessToken = async (
  db: Connection,
  row: ConnectionRow,
  client: OAuthClient | null,
): Promise<string | null> => {
  const live = row.expires_at === null || Date.parse(row.expires_at) - Date.now() > EARLY_MS
  if (live) return open({ ciphertext: row.access_ct, iv: row.access_iv })

  const token = row.refresh_ct && row.refresh_iv ? await open({ ciphertext: row.refresh_ct, iv: row.refresh_iv }) : null

  if (!client || !token) {
    await flag(db, row.id, "This connection expired and cannot be renewed on its own. Press Reconnect.")
    return null
  }

  try {
    const tokens = await refresh(client, token)
    await restamp(db, row, tokens)
    return tokens.accessToken
  } catch (error) {
    await flag(db, row.id, error instanceof Error ? error.message : "Google refused to renew this connection.")
    return null
  }
}

// Whether the connection carries a permission, according to Google rather than
// according to what was asked for. Someone can untick Ads on the consent screen
// and every other part of this still works, so the Ads panel has to be able to
// say "you did not grant that" instead of showing an API error.
export const granted = (row: ConnectionRow | null, scope: string): boolean =>
  (row?.scope ?? "").split(/\s+/).includes(scope)
