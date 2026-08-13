import { config } from "../config/index.ts"
import type { OAuthClient, OAuthTokens } from "../oauth/index.ts"
import { networkLabel } from "./networks.ts"

// Working out what a token actually points at.
//
// This is the part the AI providers never needed. Nine networks return nine
// unrelated answers to "whose account is this", and three of them do not hand
// back a usable token at all until something is traded for it — Facebook and
// Instagram want a Page's, Pinterest wants a board before a pin has anywhere to
// go. All of that happens once, on the way back from consent, so a connection
// that looks live is one that can actually post.
//
// Which client to use is ./apps.ts. This file is only what to do with the token.

// The redirect URI every network is registered against. One value, printed on
// the settings screen, so what an operator pastes into a developer console and
// what we send are the same string — a mismatch here is the single most common
// reason one of these flows fails, and it fails with a message about our
// request rather than about their console.
export const redirectUri = (): string => `${config.publicUrl.replace(/\/$/, "")}/social/oauth/callback`

export type Identified = {
  // What a human calls this connection. A page name, a channel, an @handle.
  readonly name: string | null
  // What the network calls it. Publishers address the account by this, so it is
  // the load-bearing half: a Page id, a channel id, a board, a location.
  readonly remoteId: string | null
  readonly meta: Record<string, unknown>
  // Facebook and Instagram are the reason this is here. The token the OAuth
  // dance returns belongs to the *person*, and posting needs the Page's — so
  // identifying the account is also when the token gets replaced.
  readonly tokens: OAuthTokens
}

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error("That network's reply was not JSON")
  }
}

const str = (source: Record<string, unknown> | undefined, key: string): string | null => {
  const value = source?.[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 200) : null
}

const nested = (source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined => {
  const value = source?.[key]
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const listOf = (source: Record<string, unknown> | undefined, key: string): Record<string, unknown>[] => {
  const value = source?.[key]
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

const bearer = (tokens: OAuthTokens): Record<string, string> => ({ authorization: `Bearer ${tokens.accessToken}` })

const GRAPH = "https://graph.facebook.com/v21.0"

// ------------------------------------------------------------------ meta

// A Page token minted from a long-lived user token does not expire, which is
// the only reason this exchange happens at connect time rather than per post:
// it converts a two-hour connection into a standing one. Both Facebook and
// Instagram need it, so it is one function.
const pageFor = async (
  client: OAuthClient,
  tokens: OAuthTokens,
  fields: string,
): Promise<{ page: Record<string, unknown>; pages: Record<string, unknown>[]; token: string }> => {
  let userToken = tokens.accessToken

  if (client.clientSecret) {
    const url = new URL(`${GRAPH}/oauth/access_token`)
    url.searchParams.set("grant_type", "fb_exchange_token")
    url.searchParams.set("client_id", client.clientId)
    url.searchParams.set("client_secret", client.clientSecret)
    url.searchParams.set("fb_exchange_token", userToken)
    // A failure here is not fatal — the short-lived token still works for the
    // next two hours, and the Page token below is what gets stored anyway.
    const long = await fetch(url)
      .then(readJson)
      .catch(() => null)
    userToken = str(long ?? undefined, "access_token") ?? userToken
  }

  const url = new URL(`${GRAPH}/me/accounts`)
  url.searchParams.set("fields", fields)
  url.searchParams.set("access_token", userToken)

  const pages = listOf(await fetch(url).then(readJson), "data")
  const page = pages.find(item => typeof item.access_token === "string")
  if (!page) {
    throw new Error(
      "That account does not manage a Page, or the Page permissions were not granted. Inkling posts to Pages, not profiles.",
    )
  }

  return { page, pages, token: str(page, "access_token") ?? userToken }
}

const facebook = async (client: OAuthClient, tokens: OAuthTokens): Promise<Identified> => {
  const { page, pages, token } = await pageFor(client, tokens, "id,name,access_token,category")

  return {
    name: str(page, "name"),
    remoteId: str(page, "id"),
    meta: {
      pageName: str(page, "name"),
      category: str(page, "category"),
      // Kept so the accounts screen can say "one of 3 Pages" rather than
      // implying the one we picked was the only one.
      pageCount: pages.length,
    },
    tokens: { ...tokens, accessToken: token, expiresAt: null, refreshToken: null },
  }
}

const instagram = async (client: OAuthClient, tokens: OAuthTokens): Promise<Identified> => {
  const { page, token } = await pageFor(client, tokens, "id,name,access_token,instagram_business_account")

  const linked = nested(page, "instagram_business_account")
  const igId = str(linked, "id")
  if (!igId) {
    throw new Error(
      `The Page "${str(page, "name") ?? "you authorized"}" has no Instagram Business account linked to it. Link one in Facebook Page settings, then reconnect.`,
    )
  }

  const profile = await fetch(`${GRAPH}/${igId}?fields=username,name&access_token=${encodeURIComponent(token)}`)
    .then(readJson)
    .catch(() => ({}) as Record<string, unknown>)

  const handle = str(profile, "username")
  return {
    name: handle ? `@${handle}` : (str(profile, "name") ?? str(page, "name")),
    remoteId: igId,
    meta: { handle, pageId: str(page, "id"), pageName: str(page, "name") },
    tokens: { ...tokens, accessToken: token, expiresAt: null, refreshToken: null },
  }
}

const threads = async (tokens: OAuthTokens): Promise<Identified> => {
  const url = new URL("https://graph.threads.net/v1.0/me")
  url.searchParams.set("fields", "id,username,name,threads_profile_picture_url")

  const me = await fetch(url, { headers: bearer(tokens) }).then(readJson)
  const handle = str(me, "username")

  return {
    name: handle ? `@${handle}` : str(me, "name"),
    remoteId: str(me, "id"),
    meta: { handle, avatar: str(me, "threads_profile_picture_url") },
    tokens,
  }
}

// ---------------------------------------------------------------- the rest

const youtube = async (tokens: OAuthTokens): Promise<Identified> => {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels")
  url.searchParams.set("part", "snippet")
  url.searchParams.set("mine", "true")

  const payload = await fetch(url, { headers: bearer(tokens) }).then(readJson)
  const channel = listOf(payload, "items")[0]
  const snippet = nested(channel, "snippet") ?? {}
  const thumbnails = nested(nested(snippet, "thumbnails"), "default")

  return {
    name: str(snippet, "title"),
    remoteId: str(channel, "id"),
    meta: { handle: str(snippet, "customUrl"), avatar: str(thumbnails, "url") },
    tokens,
  }
}

const x = async (tokens: OAuthTokens): Promise<Identified> => {
  const url = new URL("https://api.x.com/2/users/me")
  url.searchParams.set("user.fields", "profile_image_url,username,name")

  const payload = await fetch(url, { headers: bearer(tokens) }).then(readJson)
  const user = nested(payload, "data") ?? {}
  const handle = str(user, "username")

  return {
    name: handle ? `@${handle}` : str(user, "name"),
    remoteId: str(user, "id"),
    meta: { handle, displayName: str(user, "name"), avatar: str(user, "profile_image_url") },
    tokens,
  }
}

const tiktok = async (tokens: OAuthTokens): Promise<Identified> => {
  const url = new URL("https://open.tiktokapis.com/v2/user/info/")
  url.searchParams.set("fields", "open_id,display_name,avatar_url,username")

  const payload = await fetch(url, { headers: bearer(tokens) }).then(readJson)
  const user = nested(nested(payload, "data"), "user")
  // open_id also rides in the token response, and is the one field TikTok
  // guarantees — user/info needs a scope the operator may have declined.
  const openId = str(user, "open_id") ?? str(tokens.payload, "open_id")
  const handle = str(user, "username")

  return {
    name: str(user, "display_name") ?? (handle ? `@${handle}` : null),
    remoteId: openId,
    meta: { handle, avatar: str(user, "avatar_url") },
    tokens,
  }
}

const linkedin = async (tokens: OAuthTokens): Promise<Identified> => {
  // OpenID's userinfo, because LinkedIn retired /v2/me for new apps and this is
  // what the current scopes grant. `sub` is the member id the post is authored
  // by, so a failure here is fatal rather than cosmetic.
  const me = await fetch("https://api.linkedin.com/v2/userinfo", { headers: bearer(tokens) }).then(readJson)
  const id = str(me, "sub")
  if (!id) throw new Error("LinkedIn did not return the member id. Add the 'Sign In with LinkedIn' product to the app.")

  return {
    name: str(me, "name") ?? str(me, "email"),
    remoteId: id,
    meta: { urn: `urn:li:person:${id}`, avatar: str(me, "picture") },
    tokens,
  }
}

const pinterest = async (tokens: OAuthTokens): Promise<Identified> => {
  const account = await fetch("https://api.pinterest.com/v5/user_account", { headers: bearer(tokens) }).then(readJson)

  // A pin has to land on a board, so one is chosen now rather than at post
  // time — an account with no board is a connection that cannot post, and
  // saying so here beats saying it on a Saturday.
  const boards = await fetch("https://api.pinterest.com/v5/boards?page_size=25", { headers: bearer(tokens) })
    .then(readJson)
    .catch(() => ({}) as Record<string, unknown>)
  const first = listOf(boards, "items")[0]
  if (!first) {
    throw new Error("That Pinterest account has no boards. Create one, then reconnect — a pin has to go somewhere.")
  }

  const handle = str(account, "username")
  return {
    name: handle ? `@${handle}` : str(account, "business_name"),
    remoteId: str(first, "id"),
    meta: {
      handle,
      boardId: str(first, "id"),
      boardName: str(first, "name"),
      boardCount: listOf(boards, "items").length,
      avatar: str(account, "profile_image"),
    },
    tokens,
  }
}

const googlebusiness = async (tokens: OAuthTokens): Promise<Identified> => {
  const accounts = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
    headers: bearer(tokens),
  }).then(readJson)

  const account = listOf(accounts, "accounts")[0]
  const accountName = str(account, "name")
  if (!accountName) throw new Error("That Google account manages no Business Profile.")

  const locations = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`)
  locations.searchParams.set("readMask", "name,title,storefrontAddress")
  locations.searchParams.set("pageSize", "20")

  const found = await fetch(locations, { headers: bearer(tokens) }).then(readJson)
  const location = listOf(found, "locations")[0]
  const locationName = str(location, "name")
  if (!locationName) {
    throw new Error(`"${str(account, "accountName") ?? accountName}" has no locations. A post goes to a location.`)
  }

  return {
    name: str(location, "title") ?? str(account, "accountName"),
    // The v4 posts endpoint wants both halves of the path, so both are stored
    // together rather than reassembled from two columns at post time.
    remoteId: `${accountName}/${locationName}`,
    meta: {
      account: accountName,
      location: locationName,
      title: str(location, "title"),
      locationCount: listOf(found, "locations").length,
    },
    tokens,
  }
}

// Called once, on the way back from consent. A network that cannot say who it
// just authorized is a connection nobody can tell apart from another, so a
// failure here refuses the connection rather than storing an anonymous token.
export const identify = async (network: string, client: OAuthClient, tokens: OAuthTokens): Promise<Identified> => {
  switch (network) {
    case "facebook":
      return facebook(client, tokens)
    case "instagram":
      return instagram(client, tokens)
    case "threads":
      return threads(tokens)
    case "youtube":
      return youtube(tokens)
    case "x":
      return x(tokens)
    case "tiktok":
      return tiktok(tokens)
    case "linkedin":
      return linkedin(tokens)
    case "pinterest":
      return pinterest(tokens)
    case "googlebusiness":
      return googlebusiness(tokens)
    default:
      throw new Error(`${networkLabel(network)} is not a network Inkling can post to`)
  }
}
