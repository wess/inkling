import { reachable } from "../media.ts"
import type { PublishContext, Published } from "./index.ts"
import { pollUntil, readJson, str } from "./index.ts"

// Instagram, through the Graph API's content publishing endpoints.
//
// Nothing here posts in one call. Every shape — a photo, a reel, a carousel —
// is *container then publish*: describe the media, get a creation id, then ask
// for that id to be published. A carousel is that twice over, once per child
// and once for the album.
//
// The wait in the middle is real rather than defensive. A video container is
// transcoded before it can be published, and publishing early is the classic
// "media not ready" — so the status poll is part of the recipe, not a retry.
//
// Like Facebook, Instagram *fetches* the media from your site rather than being
// handed it, which makes PUBLIC_URL load-bearing and worth checking up front.

const GRAPH = "https://graph.facebook.com/v21.0"

const form = (fields: Record<string, string>): URLSearchParams => new URLSearchParams(fields)

// A container that is not FINISHED cannot be published, and Instagram reports
// that as an error about the media rather than about the timing.
const settle = async (token: string, creationId: string): Promise<void> => {
  await pollUntil<true>(
    async () => {
      const url = new URL(`${GRAPH}/${creationId}`)
      url.searchParams.set("fields", "status_code,status")
      url.searchParams.set("access_token", token)

      const payload = await readJson(await fetch(url))
      const state = str(payload, "status_code")
      if (state === "FINISHED") return true
      if (state === "ERROR" || state === "EXPIRED") {
        throw new Error(str(payload, "status") ?? "Instagram could not process that media")
      }
      return null
    },
    { tries: 30, waitMs: 4000 },
  )
}

const container = async (token: string, igUser: string, fields: Record<string, string>): Promise<string> => {
  const payload = await readJson(
    await fetch(`${GRAPH}/${igUser}/media`, { method: "POST", body: form({ ...fields, access_token: token }) }),
  )
  const id = str(payload, "id")
  if (!id) throw new Error("Instagram accepted the media but returned no container id")
  return id
}

export const publish = async (context: PublishContext): Promise<Published> => {
  const igUser = context.account.account_id
  if (!igUser) throw new Error("This connection has no Instagram account on it. Reconnect it.")

  const unreachable = context.media.find(item => !reachable(item.url))
  if (unreachable) {
    throw new Error(
      `Instagram downloads media from your site, and ${unreachable.url} is not an address it can reach. Set PUBLIC_URL to a public origin.`,
    )
  }

  const token = context.token
  const caption = [context.caption, context.link]
    .filter(part => part && part.trim() !== "")
    .join("\n\n")
    .slice(0, 2_200)

  const video = context.media.find(item => item.isVideo)
  const images = context.media.filter(item => item.isImage)

  let creation: string

  if (video) {
    // A single video is a Reel. Instagram has had no other kind of video post
    // since v21, and asking for one is an error about an unsupported type.
    creation = await container(token, igUser, { media_type: "REELS", video_url: video.url, caption })
    await settle(token, creation)
  } else if (images.length === 1 && images[0]) {
    creation = await container(token, igUser, { image_url: images[0].url, caption })
  } else if (images.length > 1) {
    const children: string[] = []
    for (const image of images) {
      children.push(await container(token, igUser, { image_url: image.url, is_carousel_item: "true" }))
    }
    creation = await container(token, igUser, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption,
    })
  } else {
    throw new Error("Instagram needs an image or a video")
  }

  const published = await readJson(
    await fetch(`${GRAPH}/${igUser}/media_publish`, {
      method: "POST",
      body: form({ creation_id: creation, access_token: token }),
    }),
  )

  const id = str(published, "id")
  if (!id) throw new Error("Instagram accepted the post but returned no id")

  // The permalink is a separate read, and a post that exists is not worth
  // failing over a link — so a failure here costs the URL and nothing else.
  const link = await fetch(`${GRAPH}/${id}?fields=permalink&access_token=${encodeURIComponent(token)}`)
    .then(readJson)
    .then(payload => str(payload, "permalink"))
    .catch(() => null)

  return { remoteId: id, url: link }
}
