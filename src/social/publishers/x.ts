import { decodeObject } from "../../json/index.ts"
import type { Attachment } from "../media.ts"
import type { Json, PublishContext, Published } from "./index.ts"
import { bearer, nested, option, readJson, str } from "./index.ts"

// X, through the v2 API on a user-context OAuth 2.0 token.
//
// Media is a separate service with its own protocol, and the two paths through
// it are genuinely different: an image goes up in one request, a video goes up
// in three plus a poll, because X transcodes it and the tweet cannot reference
// the media until that finishes. Posting a video before the transcode is done
// is the classic "media_id is invalid" — the id exists, it is just not usable
// yet.

const API = "https://api.x.com/2"
const UPLOAD = `${API}/media/upload`

// X's simple upload tops out well below this; anything larger has to be
// chunked. 4MB keeps images on the one-request path with room to spare.
const SIMPLE_MAX = 4 * 1024 * 1024
const CHUNK = 4 * 1024 * 1024

// X has moved this response shape more than once, and an install can be talking
// to either. Reading every spelling costs four lines and saves a release.
const mediaIdIn = (payload: Json): string => {
  const data = nested(payload, "data")
  const id = str(data, "id") ?? str(data, "media_id_string") ?? str(payload, "media_id_string") ?? str(payload, "id")
  if (!id) throw new Error("X accepted the upload but returned no media id")
  return id
}

const categoryFor = (item: Attachment): string => {
  if (item.isVideo) return "tweet_video"
  return item.mime === "image/gif" ? "tweet_gif" : "tweet_image"
}

const simple = async (token: string, item: Attachment, blob: Blob): Promise<string> => {
  const form = new FormData()
  form.set("media", blob, item.filename)
  form.set("media_category", categoryFor(item))

  return mediaIdIn(await readJson(await fetch(UPLOAD, { method: "POST", headers: bearer(token), body: form })))
}

// INIT / APPEND / FINALIZE, then wait for the transcode. The status poll is
// only issued when X says one is pending — for an image it never is, and asking
// anyway would turn every upload into two requests.
const chunked = async (token: string, item: Attachment, blob: Blob): Promise<string> => {
  const init = await readJson(
    await fetch(UPLOAD, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        command: "INIT",
        total_bytes: String(blob.size),
        media_type: item.mime,
        media_category: categoryFor(item),
      }).toString(),
    }),
  )
  const mediaId = mediaIdIn(init)

  for (let index = 0, offset = 0; offset < blob.size; index += 1, offset += CHUNK) {
    const form = new FormData()
    form.set("command", "APPEND")
    form.set("media_id", mediaId)
    form.set("segment_index", String(index))
    form.set("media", blob.slice(offset, Math.min(offset + CHUNK, blob.size)), item.filename)

    const response = await fetch(UPLOAD, { method: "POST", headers: bearer(token), body: form })
    // APPEND answers 204 with no body on success, which readJson would call a
    // reply that was not JSON.
    if (!response.ok) await readJson(response)
  }

  const finalized = await readJson(
    await fetch(UPLOAD, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ command: "FINALIZE", media_id: mediaId }).toString(),
    }),
  )

  await settle(token, mediaId, finalized)
  return mediaId
}

const processingIn = (payload: Json): Json | undefined =>
  nested(nested(payload, "data") ?? payload, "processing_info") ?? nested(payload, "processing_info")

const settle = async (token: string, mediaId: string, finalized: Json): Promise<void> => {
  let info = processingIn(finalized)

  for (let attempt = 0; info && attempt < 30; attempt += 1) {
    const state = str(info, "state")
    if (state === "succeeded") return
    if (state === "failed") {
      const reason = nested(info, "error")
      throw new Error(str(reason, "message") ?? "X could not process that video")
    }

    const seconds = Number(info.check_after_secs)
    await new Promise(resolve => setTimeout(resolve, (Number.isFinite(seconds) && seconds > 0 ? seconds : 3) * 1000))

    const status = new URL(UPLOAD)
    status.searchParams.set("command", "STATUS")
    status.searchParams.set("media_id", mediaId)
    info = processingIn(await readJson(await fetch(status, { headers: bearer(token) })))
  }

  if (info) throw new Error("X is still processing that video. It was not posted.")
}

const upload = async (token: string, item: Attachment): Promise<string> => {
  const blob = await item.bytes()
  return blob.size > SIMPLE_MAX || item.isVideo ? chunked(token, item, blob) : simple(token, item, blob)
}

export const publish = async (context: PublishContext): Promise<Published> => {
  const mediaIds: string[] = []
  for (const item of context.media) mediaIds.push(await upload(context.token, item))

  // X has no link field; a URL in the text is the link, and it is what the
  // 280-character count already measured in src/social/networks.ts.
  const text = [context.caption, context.link].filter(part => part && part.trim() !== "").join("\n\n")

  const body: Json = { text }
  if (mediaIds.length > 0) body.media = { media_ids: mediaIds }

  const replySettings = option(context.options, "replySettings", "everyone")
  if (replySettings !== "everyone") body.reply_settings = replySettings

  const payload = await readJson(
    await fetch(`${API}/tweets`, {
      method: "POST",
      headers: { ...bearer(context.token), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

  const id = str(nested(payload, "data"), "id")
  if (!id) throw new Error("X accepted the post but returned no id")

  const handle = decodeObject(context.account.meta).handle
  return {
    remoteId: id,
    url: `https://x.com/${typeof handle === "string" && handle ? handle : "i"}/status/${id}`,
  }
}
