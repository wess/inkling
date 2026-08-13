import { decodeObject } from "../../json/index.ts"
import { reachable } from "../media.ts"
import type { Json, PublishContext, Published } from "./index.ts"
import { bearer, option, readJson, str } from "./index.ts"

// Google Business Profile, through the local posts endpoint.
//
// The odd one here: the API is split across four hosts and the *posting* half
// never moved to v1, so account and location discovery happen on the modern
// hosts (see ../oauth.ts) and the post itself goes to `mybusiness.googleapis.com/v4`.
// That is not an oversight to tidy up later — v4 is where local posts live.
//
// A post is attached to one location, not to a business. The connection stores
// both halves of the path together for exactly that reason.

const API = "https://mybusiness.googleapis.com/v4"

// Every call to action but CALL needs somewhere to go, and Google rejects the
// post rather than dropping the button.
const NEEDS_URL = new Set(["LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP"])

export const publish = async (context: PublishContext): Promise<Published> => {
  const target = context.account.account_id ?? str(decodeObject(context.account.meta), "location")
  if (!target) throw new Error("This connection has no Business Profile location on it. Reconnect the account.")

  const summary = context.caption.trim()
  if (!summary) throw new Error("Google Business needs something to say — a post here is text with an optional photo")

  const image = context.media.find(item => item.isImage)
  if (image && !reachable(image.url)) {
    throw new Error(
      `Google downloads photos from your site, and ${image.url} is not an address it can reach. Set PUBLIC_URL to a public origin.`,
    )
  }

  const action = option(context.options, "action")
  if (action && NEEDS_URL.has(action) && !context.link) {
    throw new Error(`The "${action.toLowerCase().replace(/_/g, " ")}" button needs the post's link to be set`)
  }

  const body: Json = {
    languageCode: "en-US",
    summary: summary.slice(0, 1_500),
    topicType: "STANDARD",
    ...(image ? { media: [{ mediaFormat: "PHOTO", sourceUrl: image.url }] } : {}),
    ...(action
      ? {
          callToAction: {
            actionType: action,
            ...(action === "CALL" ? {} : { url: context.link }),
          },
        }
      : {}),
  }

  const payload = await readJson(
    await fetch(`${API}/${target}/localPosts`, {
      method: "POST",
      headers: { ...bearer(context.token), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

  const name = str(payload, "name")
  if (!name) throw new Error("Google accepted the post but returned no id")

  // `searchUrl` is the only public link Google hands back, and it points at the
  // profile rather than the post. A constructed one would be a guess.
  return { remoteId: name, url: str(payload, "searchUrl") }
}
