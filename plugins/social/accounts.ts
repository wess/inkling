import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { open, seal } from "../../src/ai/secrets.ts"
import { one, rows as query } from "../../src/db/dialect.ts"
import { id as newId } from "../../src/ids/index.ts"
import type { OAuthTokens } from "../../src/oauth/index.ts"
import { refresh } from "../../src/oauth/index.ts"
import { now } from "../../src/time/index.ts"
import { clientFor } from "./oauth.ts"

// Reading and writing `social_accounts`. Every token crosses this boundary
// sealed; nothing above it ever holds ciphertext, and nothing below it ever
// holds plaintext for longer than a request.

export type AccountRow = {
  id: string
  network: string
  client_id: string
  account_name: string | null
  account_id: string | null
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
}

export type AccountView = {
  readonly id: string
  readonly network: string
  readonly clientId: string
  readonly account: string | null
  readonly scope: string | null
  readonly expiresAt: string | null
  readonly error: string | null
  readonly connectedAt: string
}

// A token due to expire inside this window is refreshed before it is handed
// out, so a caller never gets one that dies mid-request.
const EARLY_MS = 5 * 60 * 1000

export const present = (row: AccountRow): AccountView => ({
  id: row.id,
  network: row.network,
  clientId: row.client_id,
  account: row.account_name,
  scope: row.scope,
  expiresAt: row.expires_at,
  error: row.error,
  connectedAt: row.connected_at,
})

export const list = (db: Connection): Promise<AccountRow[]> =>
  query<AccountRow>(db, from("social_accounts", "a").orderBy("a.network", "ASC"))

export const byId = (db: Connection, id: string): Promise<AccountRow | null> =>
  one<AccountRow>(
    db,
    from("social_accounts", "a").where(q => q("a.id").equals(id)),
  )

export const forNetwork = (db: Connection, network: string, clientId: string): Promise<AccountRow | null> =>
  one<AccountRow>(
    db,
    from("social_accounts", "a")
      .where(q => q("a.network").equals(network))
      .where(q => q("a.client_id").equals(clientId)),
  )

export const remove = async (db: Connection, id: string): Promise<void> => {
  await db.execute(
    from("social_accounts")
      .where(q => q("id").equals(id))
      .del(),
  )
}

// Connecting and reconnecting are the same write: an operator who authorizes a
// network they already hold means "replace that", never "keep both".
export const save = async (
  db: Connection,
  input: {
    readonly network: string
    readonly clientId: string
    readonly account: string | null
    readonly accountId: string | null
    readonly userId: string | null
    readonly tokens: OAuthTokens
  },
): Promise<AccountRow> => {
  const access = await seal(input.tokens.accessToken)
  const refreshed = input.tokens.refreshToken ? await seal(input.tokens.refreshToken) : null
  const stamp = now()
  const existing = await forNetwork(db, input.network, input.clientId)

  const fields = {
    account_name: input.account,
    account_id: input.accountId,
    scope: input.tokens.scope,
    access_ct: access.ciphertext,
    access_iv: access.iv,
    refresh_ct: refreshed?.ciphertext ?? null,
    refresh_iv: refreshed?.iv ?? null,
    expires_at: input.tokens.expiresAt,
    error: null,
    updated_at: stamp,
  }

  if (existing) {
    await db.execute(
      from("social_accounts")
        .update(fields)
        .where(q => q("id").equals(existing.id)),
    )
    return { ...existing, ...fields }
  }

  const row: AccountRow = {
    id: newId(),
    network: input.network,
    client_id: input.clientId,
    connected_by: input.userId,
    connected_at: stamp,
    ...fields,
  }
  await db.execute(from("social_accounts").insert(row))
  return row
}

const flag = async (db: Connection, id: string, message: string): Promise<void> => {
  await db.execute(
    from("social_accounts")
      .update({ error: message, updated_at: now() })
      .where(q => q("id").equals(id)),
  )
}

// The only way to get a usable token. It refreshes when one is close to
// expiring, records the provider's own words when that fails, and returns null
// rather than throwing — a stale connection is a thing to show in the panel,
// not an exception for a caller that only wanted to post a photo.
export const accessToken = async (db: Connection, row: AccountRow): Promise<string | null> => {
  const live = row.expires_at === null || Date.parse(row.expires_at) - Date.now() > EARLY_MS
  if (live) return open({ ciphertext: row.access_ct, iv: row.access_iv })

  const client = clientFor(row.network)
  const token = row.refresh_ct && row.refresh_iv ? await open({ ciphertext: row.refresh_ct, iv: row.refresh_iv }) : null

  if (!client || !token) {
    await flag(db, row.id, "This connection has expired and cannot be renewed automatically. Reconnect it.")
    return null
  }

  try {
    const tokens = await refresh(client, token)
    await save(db, {
      network: row.network,
      clientId: row.client_id,
      account: row.account_name,
      accountId: row.account_id,
      userId: row.connected_by,
      tokens,
    })
    return tokens.accessToken
  } catch (error) {
    await flag(db, row.id, error instanceof Error ? error.message : "The network refused to renew this connection.")
    return null
  }
}
