import { config } from "../config/index.ts"
import type { ProviderName } from "./providers.ts"
import { PROVIDERS } from "./providers.ts"
import { open, seal } from "./secrets.ts"

// Authorization-code + PKCE, for operators who would rather authorize an
// account than paste a key that never expires.
//
// The client id and secret come from the environment because they have to: an
// OAuth client is registered *with the provider* against a specific redirect
// URI, so there is nothing a self-hosted CMS can ship that stands in for one.
// That asymmetry is the whole reason API keys remain the first-class path —
// a key works the moment it is pasted, OAuth needs a registration first.

export type OAuthClient = {
  readonly provider: ProviderName
  readonly clientId: string
  readonly clientSecret: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly scopes: readonly string[]
}

export type OAuthTokens = {
  readonly accessToken: string
  readonly refreshToken: string | null
  // ISO-8601, or null when the provider issues a token that does not expire.
  readonly expiresAt: string | null
  readonly scope: string | null
  readonly account: string | null
}

// One place, so the value in the provider's dashboard and the value we send are
// the same string. Public rather than under /api because the browser arrives
// here by top-level navigation from the provider, carrying no bearer token.
export const redirectUri = (): string => `${config.publicUrl.replace(/\/$/, "")}/ai/oauth/callback`

export const clientFor = (provider: ProviderName): OAuthClient | null => {
  const configured = config.aiOauth[provider]
  const defaults = PROVIDERS[provider].oauth

  const authorizeUrl = configured.authorizeUrl || defaults?.authorizeUrl || ""
  const tokenUrl = configured.tokenUrl || defaults?.tokenUrl || ""
  const scopes = configured.scopes.length > 0 ? configured.scopes : (defaults?.scopes ?? [])

  if (!configured.clientId || !authorizeUrl || !tokenUrl) return null

  return {
    provider,
    clientId: configured.clientId,
    clientSecret: configured.clientSecret,
    authorizeUrl,
    tokenUrl,
    scopes,
  }
}

export const oauthReady = (provider: ProviderName): boolean => clientFor(provider) !== null

// --------------------------------------------------------------------- PKCE

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const verifier = (): string => base64url(crypto.getRandomValues(new Uint8Array(32)))

const challengeFor = async (value: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))

// ---------------------------------------------------------------- the state

// The `state` parameter travels through the provider and back through the
// user's browser, so it is sealed rather than stored: it carries the PKCE
// verifier and the admin who started the flow, and neither is readable or
// forgeable by whatever hands it back. Storing it in a table would mean a row
// per abandoned click and a sweep to remove them, for a value that is worthless
// ten minutes later — the same trade preview tokens make.
type Pending = {
  readonly provider: ProviderName
  readonly verifier: string
  readonly userId: string
  readonly expires: number
  readonly nonce: string
}

const STATE_TTL_MS = 10 * 60 * 1000

const packState = async (pending: Pending): Promise<string> => {
  const sealed = await seal(JSON.stringify(pending))
  return base64url(new TextEncoder().encode(`${sealed.iv}:${sealed.ciphertext}`))
}

const unpackState = async (raw: string): Promise<Pending | null> => {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/")
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), character => character.charCodeAt(0)),
    )
    const separator = decoded.indexOf(":")
    if (separator < 0) return null

    const plaintext = await open({ iv: decoded.slice(0, separator), ciphertext: decoded.slice(separator + 1) })
    if (!plaintext) return null

    const pending = JSON.parse(plaintext) as Pending
    if (typeof pending.verifier !== "string" || typeof pending.provider !== "string") return null
    if (!Number.isFinite(pending.expires) || pending.expires < Date.now()) return null
    return pending
  } catch {
    return null
  }
}

export const authorizeUrl = async (
  client: OAuthClient,
  userId: string,
): Promise<{ url: string; expiresAt: string }> => {
  const codeVerifier = verifier()
  const expires = Date.now() + STATE_TTL_MS
  const state = await packState({
    provider: client.provider,
    verifier: codeVerifier,
    userId,
    expires,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(9))),
  })

  const url = new URL(client.authorizeUrl)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", client.clientId)
  url.searchParams.set("redirect_uri", redirectUri())
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", await challengeFor(codeVerifier))
  url.searchParams.set("code_challenge_method", "S256")
  if (client.scopes.length > 0) url.searchParams.set("scope", client.scopes.join(" "))

  return { url: url.toString(), expiresAt: new Date(expires).toISOString() }
}

export const readState = unpackState

// ------------------------------------------------------------------- tokens

type TokenPayload = {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  account?: { email_address?: unknown; email?: unknown } | null
  organization?: { name?: unknown } | null
}

const accountFrom = (payload: TokenPayload): string | null => {
  const email = payload.account?.email_address ?? payload.account?.email
  if (typeof email === "string" && email) return email
  const organization = payload.organization?.name
  return typeof organization === "string" && organization ? organization : null
}

// RFC 6749 says the token request is form-encoded, and that is what we send.
// Several large providers accept only JSON, though, and an operator hitting
// that has no way to tell from the error — so one retry in the other encoding
// is cheaper than a configuration knob nobody would know how to set.
const post = async (url: string, fields: Record<string, string>): Promise<Response> => {
  const form = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  })
  if (form.ok || form.status >= 500) return form

  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(fields),
  })
}

const toTokens = (payload: TokenPayload): OAuthTokens => {
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("The provider's response carried no access token")
  }
  const lifetime = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in)
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? new Date(Date.now() + lifetime * 1000).toISOString() : null,
    scope: typeof payload.scope === "string" ? payload.scope : null,
    account: accountFrom(payload),
  }
}

// The provider's own error text is the actionable part — "redirect_uri mismatch"
// is the whole diagnosis — and it describes our request, not our secret.
const readOrThrow = async (response: Response): Promise<TokenPayload> => {
  const text = await response.text()
  if (!response.ok) throw new Error(`Provider rejected the token request (${response.status}): ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text) as TokenPayload
  } catch {
    throw new Error("The provider's token response was not JSON")
  }
}

export const exchange = async (client: OAuthClient, code: string, codeVerifier: string): Promise<OAuthTokens> => {
  const fields: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: client.clientId,
    code_verifier: codeVerifier,
  }
  if (client.clientSecret) fields.client_secret = client.clientSecret
  return toTokens(await readOrThrow(await post(client.tokenUrl, fields)))
}

export const refresh = async (client: OAuthClient, refreshToken: string): Promise<OAuthTokens> => {
  const fields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  }
  if (client.clientSecret) fields.client_secret = client.clientSecret

  const tokens = toTokens(await readOrThrow(await post(client.tokenUrl, fields)))
  // Providers differ on whether a refresh rotates the refresh token. Keeping
  // the old one when none comes back is what makes both behaviours work.
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken }
}
