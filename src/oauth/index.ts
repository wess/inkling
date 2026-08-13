import { open, seal } from "../ai/secrets.ts"

// Authorization-code + PKCE, with nothing in it that knows what is being
// authorized. Two features need this exact dance — connecting an AI provider
// and connecting a social account — and the second one arriving is what made it
// worth having in one place rather than two.
//
// What stays with the caller: which client to use, where the provider sends the
// browser back, and what a token response means. What lives here: the PKCE
// pair, the sealed round trip through the provider, and the two token calls.

export type OAuthClient = {
  readonly clientId: string
  readonly clientSecret: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly scopes: readonly string[]
  // Two places where a provider disagrees with RFC 6749 about spelling rather
  // than about meaning. TikTok calls the client id `client_key` and separates
  // scopes with commas; a provider that says nothing gets the spec's answer.
  // Both are named rather than branched on the provider, so this file still
  // knows nothing about what is being authorized.
  readonly clientParam?: string
  readonly scopeSeparator?: string
  // Whether the client credentials may also ride in an Authorization header.
  // X requires it; TikTok rejects the request when it is present. Defaults to
  // sending it, which is what every provider before TikTok wanted.
  readonly basicAuth?: boolean
}

const clientKey = (client: OAuthClient): string => client.clientParam ?? "client_id"

export type OAuthTokens = {
  readonly accessToken: string
  readonly refreshToken: string | null
  // ISO-8601, or null when the provider issues a token that does not expire.
  readonly expiresAt: string | null
  readonly scope: string | null
  // Everything else the provider sent. Account naming is per-provider guesswork
  // — an email here, a screen name there — so the caller reads it, not us.
  readonly payload: Record<string, unknown>
}

// --------------------------------------------------------------------- PKCE

export const base64url = (bytes: Uint8Array): string =>
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
// verifier and whatever the caller needs to finish the job, and neither is
// readable or forgeable by whatever hands it back. Storing it in a table would
// mean a row per abandoned click and a sweep to remove them, for a value that is
// worthless ten minutes later — the same trade preview tokens make.

export const STATE_TTL_MS = 10 * 60 * 1000

export type StateEnvelope<T> = T & {
  readonly verifier: string
  readonly expires: number
  readonly nonce: string
}

export const packState = async <T extends object>(payload: T, codeVerifier: string, ttlMs = STATE_TTL_MS) => {
  const expires = Date.now() + ttlMs
  const envelope = {
    ...payload,
    verifier: codeVerifier,
    expires,
    nonce: base64url(crypto.getRandomValues(new Uint8Array(9))),
  }
  const sealed = await seal(JSON.stringify(envelope))
  return { state: base64url(new TextEncoder().encode(`${sealed.iv}:${sealed.ciphertext}`)), expires }
}

// Returns null for every failure — expired, tampered with, sealed under a
// SECRET since rotated. A caller cannot act differently on any of them, and
// telling them apart out loud would be a description of our own key material.
export const readState = async <T>(raw: string): Promise<StateEnvelope<T> | null> => {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/")
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), character => character.charCodeAt(0)),
    )
    const separator = decoded.indexOf(":")
    if (separator < 0) return null

    const plaintext = await open({ iv: decoded.slice(0, separator), ciphertext: decoded.slice(separator + 1) })
    if (!plaintext) return null

    const envelope = JSON.parse(plaintext) as StateEnvelope<T>
    if (typeof envelope.verifier !== "string") return null
    if (!Number.isFinite(envelope.expires) || envelope.expires < Date.now()) return null
    return envelope
  } catch {
    return null
  }
}

// ------------------------------------------------------------------- consent

export const consentUrl = async <T extends object>(
  client: OAuthClient,
  redirectUri: string,
  payload: T,
  extra: Record<string, string> = {},
): Promise<{ url: string; expiresAt: string }> => {
  const codeVerifier = verifier()
  const { state, expires } = await packState(payload, codeVerifier)

  const url = new URL(client.authorizeUrl)
  url.searchParams.set("response_type", "code")
  url.searchParams.set(clientKey(client), client.clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", await challengeFor(codeVerifier))
  url.searchParams.set("code_challenge_method", "S256")
  if (client.scopes.length > 0) url.searchParams.set("scope", client.scopes.join(client.scopeSeparator ?? " "))
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)

  return { url: url.toString(), expiresAt: new Date(expires).toISOString() }
}

// ------------------------------------------------------------------- tokens

// RFC 6749 says the token request is form-encoded, and that is what we send.
// Several large providers accept only JSON, though, and an operator hitting
// that has no way to tell from the error — so one retry in the other encoding
// is cheaper than a configuration knob nobody would know how to set.
const send = async (url: string, fields: Record<string, string>, headers: Record<string, string>) => {
  const form = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  })
  if (form.ok || form.status >= 500) return form

  return fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(fields),
  })
}

const toTokens = (payload: Record<string, unknown>): OAuthTokens => {
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("The provider's response carried no access token")
  }
  const lifetime = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in)
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    expiresAt: Number.isFinite(lifetime) && lifetime > 0 ? new Date(Date.now() + lifetime * 1000).toISOString() : null,
    scope: typeof payload.scope === "string" ? payload.scope : null,
    payload,
  }
}

// The provider's own error text is the actionable part — "redirect_uri mismatch"
// is the whole diagnosis — and it describes our request, not our secret.
const readOrThrow = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text()
  if (!response.ok) throw new Error(`Provider rejected the token request (${response.status}): ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error("The provider's token response was not JSON")
  }
}

// Some providers (X, notably) want the client credentials in a Basic header
// rather than the body, and reject the request outright without it.
const basicAuth = (client: OAuthClient): Record<string, string> =>
  client.clientSecret && client.basicAuth !== false
    ? { authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}` }
    : {}

export const exchange = async (
  client: OAuthClient,
  redirectUri: string,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokens> => {
  const fields: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    [clientKey(client)]: client.clientId,
    code_verifier: codeVerifier,
  }
  if (client.clientSecret) fields.client_secret = client.clientSecret
  return toTokens(await readOrThrow(await send(client.tokenUrl, fields, basicAuth(client))))
}

export const refresh = async (client: OAuthClient, refreshToken: string): Promise<OAuthTokens> => {
  const fields: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    [clientKey(client)]: client.clientId,
  }
  if (client.clientSecret) fields.client_secret = client.clientSecret

  const tokens = toTokens(await readOrThrow(await send(client.tokenUrl, fields, basicAuth(client))))
  // Providers differ on whether a refresh rotates the refresh token. Keeping
  // the old one when none comes back is what makes both behaviours work.
  return tokens.refreshToken ? tokens : { ...tokens, refreshToken }
}
