import { badRequest } from "atlas/server"
import type { Settings } from "./config.ts"
import { host, VERSION } from "./config.ts"

export type Client = <T>(path: string, body?: unknown) => Promise<T>

export const request = async <T>(s: Settings, path: string, body?: unknown, authorization?: string): Promise<T> => {
  const response = await fetch(`${host(s)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Square-Version": VERSION,
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
  if (!response.ok) {
    // provider bodies can contain customer data or credentials; keep them out of logs and responses.
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403)
      throw badRequest("Square needs you to reconnect or grant the requested permissions", { code: "SQUARE_AUTH" })
    throw badRequest(
      `Square could not complete this request (${response.status}). Check the shop setup and try again.`,
      { code: "SQUARE_REQUEST" },
    )
  }
  return response.json() as Promise<T>
}

export type Tokens = { access_token: string; refresh_token: string; expires_at: string; merchant_id: string }

export const tokenRequest = async (s: Settings, grant: Record<string, string>): Promise<Tokens> => {
  const tokens = await request<Tokens>(s, "/oauth2/token", {
    client_id: s.clientId,
    client_secret: s.clientSecret,
    ...grant,
  })
  if (
    !tokens.access_token ||
    !tokens.refresh_token ||
    !tokens.merchant_id ||
    !Number.isFinite(Date.parse(tokens.expires_at)) ||
    Date.parse(tokens.expires_at) <= Date.now()
  ) {
    throw badRequest("Square returned an incomplete account connection. Please reconnect.")
  }
  return tokens
}
