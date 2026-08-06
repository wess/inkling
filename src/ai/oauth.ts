import { config } from "../config/index.ts"
import type { OAuthClient as GenericClient, OAuthTokens as GenericTokens } from "../oauth/index.ts"
import {
  consentUrl,
  exchange as genericExchange,
  readState as genericReadState,
  refresh as genericRefresh,
} from "../oauth/index.ts"
import type { ProviderName } from "./providers.ts"
import { PROVIDERS } from "./providers.ts"

// Connecting an AI provider by authorizing an account, for operators who would
// rather not paste a key that never expires. The dance itself is in
// src/oauth — what is here is the part that knows about providers.
//
// The client id and secret come from the environment because they have to: an
// OAuth client is registered *with the provider* against a specific redirect
// URI, so there is nothing a self-hosted CMS can ship that stands in for one.
// That asymmetry is the whole reason API keys remain the first-class path —
// a key works the moment it is pasted, OAuth needs a registration first.

export type OAuthClient = GenericClient & { readonly provider: ProviderName }

export type OAuthTokens = Omit<GenericTokens, "payload"> & { readonly account: string | null }

// One place, so the value in the provider's dashboard and the value we send are
// the same string. Public rather than under /api because the browser arrives
// here by top-level navigation from the provider, carrying no bearer token.
export const redirectUri = (): string => `${config.publicUrl.replace(/\/$/, "")}/ai/oauth/callback`

// A provider only appears in `config.aiOauth` if it has an environment block,
// and one is only worth adding for a provider an operator could plausibly
// register a client with. Looking it up defensively means adding a provider —
// Ollama Cloud, say — does not require five dead variables in `.env.example`
// just to satisfy an index.
const NO_OAUTH = {
  clientId: "",
  clientSecret: "",
  authorizeUrl: "",
  tokenUrl: "",
  scopes: [] as readonly string[],
}

export const clientFor = (provider: ProviderName): OAuthClient | null => {
  const blocks: Partial<Record<ProviderName, typeof NO_OAUTH>> = config.aiOauth
  const configured = blocks[provider] ?? NO_OAUTH
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

type Pending = { readonly provider: ProviderName; readonly userId: string }

export const authorizeUrl = (client: OAuthClient, userId: string): Promise<{ url: string; expiresAt: string }> =>
  consentUrl<Pending>(client, redirectUri(), { provider: client.provider, userId })

export const readState = async (raw: string) => {
  const state = await genericReadState<Pending>(raw)
  return state && typeof state.provider === "string" ? state : null
}

// Which field names the account depends on the provider; both of these are
// Anthropic's, and a provider that sends neither simply has no label to show.
const accountFrom = (payload: Record<string, unknown>): string | null => {
  const account = payload.account as { email_address?: unknown; email?: unknown } | null | undefined
  const email = account?.email_address ?? account?.email
  if (typeof email === "string" && email) return email

  const organization = payload.organization as { name?: unknown } | null | undefined
  return typeof organization?.name === "string" && organization.name ? organization.name : null
}

const named = (tokens: GenericTokens): OAuthTokens => ({
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  expiresAt: tokens.expiresAt,
  scope: tokens.scope,
  account: accountFrom(tokens.payload),
})

export const exchange = async (client: OAuthClient, code: string, codeVerifier: string): Promise<OAuthTokens> =>
  named(await genericExchange(client, redirectUri(), code, codeVerifier))

export const refresh = async (client: OAuthClient, refreshToken: string): Promise<OAuthTokens> =>
  named(await genericRefresh(client, refreshToken))
