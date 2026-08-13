import { decodeObject } from "../../json/index.ts"
import type { Attachment } from "../media.ts"
import { reachable } from "../media.ts"
import type { Json, PublishContext, Published } from "./index.ts"
import { bearer, nested, option, pollUntil, readJson, str } from "./index.ts"

// Pinterest, through the v5 Pins API.
//
// An image pin is one call and takes a URL. A video pin is four: register a
// media upload, POST the bytes to *Amazon* with the form fields Pinterest hands
// back, wait for it to be processed, then create the pin referencing the media
// id. The upload is a plain S3 form post, which is why it is the one request
// here that carries no bearer token — the credentials are in the fields.
//
// A video pin also needs a cover image, and Pinterest will not make one. The
// post has to carry one, and saying that plainly beats an error about a missing
// `cover_image_url`.

const API = "https://api.pinterest.com/v5"

const boardFor = (context: PublishContext): string => {
  const meta = decodeObject(context.account.meta)
  const chosen = option(context.options, "boardId") || str(meta, "boardId") || context.account.account_id
  if (!chosen) throw new Error("This connection has no Pinterest board on it. Reconnect the account.")
  return chosen
}

// Registers an upload and pushes the bytes to wherever Pinterest points.
const uploadVideo = async (token: string, item: Attachment): Promise<string> => {
  const registered = await readJson(
    await fetch(`${API}/media`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({ media_type: "video" }),
    }),
  )

  const mediaId = str(registered, "media_id")
  const uploadUrl = str(registered, "upload_url")
  const parameters = nested(registered, "upload_parameters")
  if (!mediaId || !uploadUrl) throw new Error("Pinterest did not open a media upload")

  const form = new FormData()
  // Order matters to S3: every policy field has to precede the file.
  for (const [key, value] of Object.entries(parameters ?? {})) form.set(key, String(value))
  form.set("file", await item.bytes(), item.filename)

  const response = await fetch(uploadUrl, { method: "POST", body: form })
  if (!response.ok) {
    throw new Error(`Pinterest refused the upload (${response.status}): ${(await response.text()).slice(0, 300)}`)
  }

  await pollUntil<true>(
    async () => {
      const status = await readJson(await fetch(`${API}/media/${mediaId}`, { headers: bearer(token) }))
      const state = (str(status, "status") ?? "").toLowerCase()
      if (state === "succeeded") return true
      if (state === "failed") throw new Error("Pinterest could not process that video")
      return null
    },
    { tries: 30, waitMs: 4000 },
  )

  return mediaId
}

export const publish = async (context: PublishContext): Promise<Published> => {
  const board = boardFor(context)
  const token = context.token

  const video = context.media.find(item => item.isVideo)
  const image = context.media.find(item => item.isImage)

  // Every path here needs an image Pinterest can fetch: as the pin itself, or
  // as the cover a video pin cannot go without.
  const cover = image
  if (!cover) {
    throw new Error(
      video
        ? "A Pinterest video pin needs a cover image. Add one to the post — Pinterest will not generate it."
        : "Pinterest needs an image",
    )
  }
  if (!reachable(cover.url)) {
    throw new Error(
      `Pinterest downloads images from your site, and ${cover.url} is not an address it can reach. Set PUBLIC_URL to a public origin.`,
    )
  }

  const source: Json = video
    ? { source_type: "video_id", cover_image_url: cover.url, media_id: await uploadVideo(token, video) }
    : { source_type: "image_url", url: cover.url }

  const payload = await readJson(
    await fetch(`${API}/pins`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: JSON.stringify({
        board_id: board,
        title: (option(context.options, "title") || context.title).slice(0, 100),
        description: context.caption.slice(0, 800),
        ...(context.link ? { link: context.link } : {}),
        ...(cover.alt ? { alt_text: cover.alt.slice(0, 500) } : {}),
        media_source: source,
      }),
    }),
  )

  const id = str(payload, "id")
  if (!id) throw new Error("Pinterest accepted the pin but returned no id")

  return { remoteId: id, url: `https://www.pinterest.com/pin/${id}/` }
}
