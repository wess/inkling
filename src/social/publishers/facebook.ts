import { reachable } from "../media.ts"
import type { PublishContext, Published } from "./index.ts"
import { readJson, str } from "./index.ts"

// Facebook Pages, through the Graph API.
//
// The one network here that fetches media rather than being handed it: every
// call below passes a URL and Graph goes and gets it. That makes this the only
// publisher that can fail because of where *Inkling* is running, so the check
// is explicit and says so — a localhost PUBLIC_URL produces a Graph error about
// a URL it could not download, which reads as Facebook's problem and is not.
//
// The token is the Page's, not the person's; ../oauth.ts trades one for the
// other at connect time, which is also what makes it long-lived.

const GRAPH = "https://graph.facebook.com/v21.0"

const form = (fields: Record<string, string>): URLSearchParams => new URLSearchParams(fields)

const requireReachable = (context: PublishContext): void => {
  const unreachable = context.media.find(item => !reachable(item.url))
  if (!unreachable) return
  throw new Error(
    `Facebook downloads media from your site, and ${unreachable.url} is not an address it can reach. Set PUBLIC_URL to a public origin.`,
  )
}

export const publish = async (context: PublishContext): Promise<Published> => {
  const pageId = context.account.account_id
  if (!pageId) throw new Error("This connection has no Facebook Page on it. Reconnect the account.")

  requireReachable(context)

  const token = context.token
  const message = context.caption
  const video = context.media.find(item => item.isVideo)

  if (video) {
    const payload = await readJson(
      await fetch(`${GRAPH}/${pageId}/videos`, {
        method: "POST",
        body: form({
          access_token: token,
          file_url: video.url,
          description: [message, context.link].filter(part => part && part.trim() !== "").join("\n\n"),
          title: context.title,
        }),
      }),
    )
    const id = str(payload, "id")
    if (!id) throw new Error("Facebook accepted the video but returned no id")
    return { remoteId: id, url: `https://www.facebook.com/${id}` }
  }

  const images = context.media.filter(item => item.isImage)

  // Every image is uploaded unpublished first, then referenced from one feed
  // post. It is two round trips for a single image where /photos would do, but
  // it is one code path for one image and for ten, and the post that comes back
  // is the same kind of object either way.
  const attached: string[] = []
  for (const image of images) {
    const payload = await readJson(
      await fetch(`${GRAPH}/${pageId}/photos`, {
        method: "POST",
        body: form({
          access_token: token,
          url: image.url,
          published: "false",
          ...(image.alt ? { alt_text_custom: image.alt } : {}),
        }),
      }),
    )
    const id = str(payload, "id")
    if (!id) throw new Error("Facebook accepted an image but returned no id")
    attached.push(id)
  }

  const fields: Record<string, string> = { access_token: token, message }
  if (context.link) fields.link = context.link
  attached.forEach((id, index) => {
    fields[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id })
  })

  const payload = await readJson(await fetch(`${GRAPH}/${pageId}/feed`, { method: "POST", body: form(fields) }))
  const id = str(payload, "id")
  if (!id) throw new Error("Facebook accepted the post but returned no id")

  return { remoteId: id, url: `https://www.facebook.com/${id}` }
}
