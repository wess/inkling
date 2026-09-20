import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { badRequest } from "atlas/server"
import { open, seal } from "../../src/ai/secrets.ts"
import { one } from "../../src/db/dialect.ts"
import type { Client, Tokens } from "./api.ts"
import { request, tokenRequest } from "./api.ts"
import type { Settings } from "./config.ts"

export type Account = {
  slot: string
  id: string
  merchant_id: string
  client_id: string
  environment: string
  access_ct: string
  access_iv: string
  refresh_ct: string
  refresh_iv: string
  expires_at: string
  connected_at: string
}

export const current = (db: Connection): Promise<Account | null> => one<Account>(db, from("square_connections"))
export const matches = (row: Account, s: Settings): boolean =>
  row.client_id === s.clientId && row.environment === s.environment

const sealedTokens = async (tokens: Tokens) => {
  const access = await seal(tokens.access_token)
  const refresh = await seal(tokens.refresh_token)
  return {
    access_ct: access.ciphertext,
    access_iv: access.iv,
    refresh_ct: refresh.ciphertext,
    refresh_iv: refresh.iv,
    expires_at: tokens.expires_at,
  }
}

export const save = async (db: Connection, s: Settings, tokens: Tokens): Promise<void> => {
  const fields = await sealedTokens(tokens)
  await db.transaction(async tx => {
    await tx.execute(from("square_connections").del())
    await tx.execute(
      from("square_connections").insert({
        slot: "shop",
        id: crypto.randomUUID(),
        merchant_id: tokens.merchant_id,
        client_id: s.clientId,
        environment: s.environment,
        connected_at: new Date().toISOString(),
        ...fields,
      }),
    )
  })
}

const refreshing = new WeakMap<Connection, Promise<void>>()

const refresh = async (db: Connection, s: Settings, row: Account): Promise<void> => {
  const refreshToken = await open({ ciphertext: row.refresh_ct, iv: row.refresh_iv })
  if (!refreshToken) throw badRequest("Reconnect Square to restore access to the shop")
  const tokens = await tokenRequest(s, { grant_type: "refresh_token", refresh_token: refreshToken })
  if (tokens.merchant_id !== row.merchant_id)
    throw badRequest("Square returned a different shop. Reconnect the account.")
  await db.execute(
    from("square_connections")
      .update(await sealedTokens(tokens))
      .where(q => q("id").equals(row.id)),
  )
}

export const connected = async (db: Connection, s: Settings): Promise<{ account: Account; api: Client }> => {
  let row = await current(db)
  if (!row || !matches(row, s) || !s.clientSecret)
    throw badRequest("Connect your Square account in Square → Setup", { code: "SQUARE_DISCONNECTED" })
  const id = row.id
  // Refresh at seven days, even for quiet shops whose first new request arrives after expiry.
  if (Date.parse(row.expires_at) - Date.now() < 23 * 86400000) {
    let pending = refreshing.get(db)
    if (!pending) {
      pending = refresh(db, s, row)
      refreshing.set(db, pending)
    }
    try {
      await pending
    } finally {
      if (refreshing.get(db) === pending) refreshing.delete(db)
    }
    row = await current(db)
    if (!row || row.id !== id || !matches(row, s)) throw badRequest("The Square connection changed. Please try again.")
  }
  const token = await open({ ciphertext: row.access_ct, iv: row.access_iv })
  if (!token) throw badRequest("Reconnect Square to restore access to the shop")
  return { account: row, api: <T>(path: string, body?: unknown) => request<T>(s, path, body, `Bearer ${token}`) }
}
