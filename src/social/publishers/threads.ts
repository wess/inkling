import { decodeObject } from "../../json/index.ts"
import { reachable } from "../media.ts"
import type { PublishContext, Published } from "./index.ts"
import { bearer, pollUntil, readJson, str } from "./index.ts"

// Threads, through the Threads API.
//
// The same container-then-publish shape Instagram uses, on a different host and
// with one difference that matters: a Threads container is not ready the moment
// it is created, and publishing an unready one fails with an error about the
// media. So a container carrying media is polled first, and a text-only one —
// which has nothing to process — is not.
//
// Threads also fetches media rather than being handed it, so PUBLIC_URL has to
// be an address it can reach.

const API = "https://graph.threads.net/v1.0"

const create = async (token: string, user: string, fields: Record<string, string>): Promise<string> => {
  const url = new URL(`${API}/${user}/threads`)
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value)

  const payload = await readJson(await fetch(url, { method: "POST", headers: bearer(token) }))
  const id = str(payload, "id")
  if (!id) throw new Error("Threads accepted the media but returned no container id")
  return id
}

const settle = async (token: string, containerId: string): Promise<void> => {
  await pollUntil<true>(
    async () => {
      const url = new URL(`${API}/${containerId}`)
      url.searchParams.set("fields", "status,error_message")

      const payload = await readJson(await fetch(url, { headers: bearer(token) }))
      const state = str(payload, "status")
      if (state === "FINISHED") return true
      if (state === "ERROR" || state === "EXPIRED") {
        throw new Error(str(payload, "error_message") ?? "Threads could not process that media")
      }
      return null
    },
    { tries: 30, waitMs: 3000 },
  )
}

export const publish = async (context: PublishContext): Promise<Published> => {
  const user = context.account.account_id
  if (!user) throw new Error("This connection has no Threads account on it. Reconnect it.")

  const unreachable = context.media.find(item => !reachable(item.url))
  if (unreachable) {
    throw new Error(
      `Threads downloads media from your site, and ${unreachable.url} is not an address it can reach. Set PUBLIC_URL to a public origin.`,
    )
  }

  const token = context.token
  const text = [context.caption, context.link]
    .filter(part => part && part.trim() !== "")
    .join("\n\n")
    .slice(0, 500)

  const video = context.media.find(item => item.isVideo)
  const images = context.media.filter(item => item.isImage)

  let creation: string

  if (video) {
    creation = await create(token, user, { media_type: "VIDEO", video_url: video.url, text })
    await settle(token, creation)
  } else if (images.length === 1 && images[0]) {
    creation = await create(token, user, { media_type: "IMAGE", image_url: images[0].url, text })
    await settle(token, creation)
  } else if (images.length > 1) {
    const children: string[] = []
    for (const image of images) {
      const child = await create(token, user, {
        media_type: "IMAGE",
        image_url: image.url,
        is_carousel_item: "true",
      })
      await settle(token, child)
      children.push(child)
    }
    creation = await create(token, user, { media_type: "CAROUSEL", children: children.join(","), text })
    await settle(token, creation)
  } else {
    // Text-only, which Threads takes and which needs no wait — there is nothing
    // to transcode.
    creation = await create(token, user, { media_type: "TEXT", text })
  }

  const url = new URL(`${API}/${user}/threads_publish`)
  url.searchParams.set("creation_id", creation)

  const published = await readJson(await fetch(url, { method: "POST", headers: bearer(token) }))
  const id = str(published, "id")
  if (!id) throw new Error("Threads accepted the post but returned no id")

  const permalink = await fetch(`${API}/${id}?fields=permalink`, { headers: bearer(token) })
    .then(readJson)
    .then(payload => str(payload, "permalink"))
    .catch(() => null)

  const handle = str(decodeObject(context.account.meta), "handle")
  return { remoteId: id, url: permalink ?? (handle ? `https://www.threads.net/@${handle}` : null) }
}
