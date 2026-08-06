import { config } from "../../src/config/index.ts"
import type { OAuthClient } from "../../src/oauth/index.ts"
import { NETWORKS } from "./networks.ts"

// Connecting the accounts a client actually posts from.
//
// Every network here requires a developer app registered *with that network*,
// against a redirect URI, usually behind a review queue that takes days. There
// is nothing a self-hosted CMS can ship that stands in for one — so the ids and
// secrets come from the environment, and a network with no block configured
// says so in the panel rather than offering a button that dead-ends.
//
// The authorize and token URLs below are each network's documented endpoints,
// and are overridable per network for the same reason core's are: a URL moves,
// or an operator is on a regional endpoint, and neither should need a release.

export type NetworkOAuth = {
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly scopes: readonly string[]
  // Extra authorize-time parameters this network insists on.
  readonly extra?: Record<string, string>
  // Where to read a human-readable account name out of the token response.
  readonly accountKeys?: readonly string[]
}

export const NETWORK_OAUTH: Readonly<Record<string, NetworkOAuth>> = {
  facebook: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
  },
  instagram: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list"],
  },
  threads: {
    authorizeUrl: "https://threads.net/oauth/authorize",
    tokenUrl: "https://graph.threads.net/oauth/access_token",
    scopes: ["threads_basic", "threads_content_publish"],
  },
  linkedin: {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["w_member_social", "r_basicprofile"],
  },
  x: {
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
  },
  tiktok: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "video.publish"],
  },
  youtube: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    // Google issues a refresh token only when both are asked for explicitly,
    // and only on the first consent — without these a connection works for an
    // hour and then quietly stops.
    extra: { access_type: "offline", prompt: "consent" },
  },
  pinterest: {
    authorizeUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    scopes: ["pins:read", "pins:write", "boards:read"],
  },
  googlebusiness: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    extra: { access_type: "offline", prompt: "consent" },
  },
}

// Newsletter is in NETWORKS because a post can go out on one; it has no OAuth
// because "newsletter" is not a network with an authorization server. Nothing
// enumerates it here and the panel therefore never offers it.
export const CONNECTABLE = NETWORKS.filter(network => network.value in NETWORK_OAUTH)

const environment = (name: string): string => (typeof Bun !== "undefined" ? Bun.env[name] : process.env[name]) ?? ""

const listOf = (value: string): readonly string[] =>
  value
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)

// The redirect URI every network is registered against. One value, printed in
// the panel, so what an operator pastes into a developer console and what we
// send are the same string — a mismatch here is the single most common reason
// one of these flows fails, and it fails with a message about our request.
export const redirectUri = (): string => `${config.publicUrl.replace(/\/$/, "")}/ext/social/oauth/callback`

export const clientFor = (network: string): OAuthClient | null => {
  const defaults = NETWORK_OAUTH[network]
  if (!defaults) return null

  const prefix = `SOCIAL_OAUTH_${network.toUpperCase()}`
  const clientId = environment(`${prefix}_CLIENT_ID`)
  if (!clientId) return null

  const authorizeUrl = environment(`${prefix}_AUTHORIZE_URL`) || defaults.authorizeUrl
  const tokenUrl = environment(`${prefix}_TOKEN_URL`) || defaults.tokenUrl
  const configured = listOf(environment(`${prefix}_SCOPES`))

  return {
    clientId,
    clientSecret: environment(`${prefix}_CLIENT_SECRET`),
    authorizeUrl,
    tokenUrl,
    scopes: configured.length > 0 ? configured : defaults.scopes,
  }
}

export const ready = (network: string): boolean => clientFor(network) !== null

// Networks disagree entirely about what identifies an account: a name, a
// username, an id, or a nested object. Reading several shapes here beats a
// per-network parser for a value that is only ever shown to a human.
export const accountFrom = (payload: Record<string, unknown>): string | null => {
  for (const key of ["username", "screen_name", "name", "account_name", "email", "open_id", "user_id"]) {
    const value = payload[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 120)
  }

  const nested = payload.data ?? payload.user ?? payload.account
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return accountFrom(nested as Record<string, unknown>)
  }
  return null
}
