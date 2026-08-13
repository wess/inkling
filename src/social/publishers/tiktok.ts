import { decodeObject } from "../../json/index.ts"
import type { Json, PublishContext, Published } from "./index.ts"
import { bearer, flagged, messageIn, nested, option, pollUntil, readJson, str } from "./index.ts"

// TikTok, through the Content Posting API.
//
// FILE_UPLOAD rather than PULL_FROM_URL: pulling requires the domain serving
// the video to be verified in TikTok's developer console, which is a step an
// operator cannot complete from inside Inkling and which fails, when skipped,
// with an error about the URL rather than about the verification. Pushing the
// bytes works from any install, including one whose PUBLIC_URL is not public.
//
// Two things here are TikTok-specific and both are load-bearing. Every response
// carries an `error` object even on success — `error.code === "ok"` is the
// success case, and a 200 with a code of anything else is a failure. And an
// app TikTok has not audited may only post SELF_ONLY; anything else comes back
// as an error about the app, not the post, which is why that is the default in
// ../networks.ts.

const API = "https://open.tiktokapis.com/v2"

// TikTok accepts a whole file as one chunk up to this size and requires real
// chunking above it. Its own minimum chunk is 5MB and maximum is 64MB.
const WHOLE_MAX = 64 * 1024 * 1024
const CHUNK = 32 * 1024 * 1024

// Success is `error.code === "ok"`, and the HTTP status agrees only sometimes.
const unwrap = (payload: Json): Json => {
  const error = nested(payload, "error")
  const code = str(error, "code")
  if (code && code.toLowerCase() !== "ok") {
    const message = str(error, "message") ?? messageIn(payload, 200)
    // The one error worth translating, because its text names a concept the
    // operator has no way to connect to what they did.
    if (code === "unaudited_client_can_only_post_to_private_account") {
      throw new Error(
        "TikTok has not audited this app yet, so it may only post with visibility set to 'Only me'. Change the post's TikTok visibility, or apply for audit in the TikTok developer console.",
      )
    }
    throw new Error(`${message} (${code})`)
  }
  return nested(payload, "data") ?? {}
}

const post = async (token: string, path: string, body: Json): Promise<Json> =>
  unwrap(
    await readJson(
      await fetch(`${API}${path}`, {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify(body),
      }),
    ),
  )

const send = async (uploadUrl: string, blob: Blob, mime: string): Promise<void> => {
  const total = blob.size
  const size = total <= WHOLE_MAX ? total : CHUNK

  for (let offset = 0; offset < total; offset += size) {
    const end = Math.min(offset + size, total) - 1
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": mime,
        "content-length": String(end - offset + 1),
        "content-range": `bytes ${offset}-${end}/${total}`,
      },
      body: blob.slice(offset, end + 1),
    })
    if (!response.ok) {
      throw new Error(`TikTok refused the upload (${response.status}): ${(await response.text()).slice(0, 300)}`)
    }
  }
}

export const publish = async (context: PublishContext): Promise<Published> => {
  const video = context.media.find(item => item.isVideo)
  if (!video) throw new Error("TikTok needs a video")

  const blob = await video.bytes()
  const total = blob.size
  const chunk = total <= WHOLE_MAX ? total : CHUNK

  const opened = await post(context.token, "/post/publish/video/init/", {
    post_info: {
      title: [context.caption, context.link]
        .filter(part => part && part.trim() !== "")
        .join(" ")
        .slice(0, 2_200),
      privacy_level: option(context.options, "privacy", "SELF_ONLY"),
      disable_comment: flagged(context.options, "disableComment"),
      disable_duet: flagged(context.options, "disableDuet"),
      disable_stitch: flagged(context.options, "disableStitch"),
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: total,
      chunk_size: chunk,
      total_chunk_count: Math.ceil(total / chunk),
    },
  })

  const publishId = str(opened, "publish_id")
  const uploadUrl = str(opened, "upload_url")
  if (!publishId || !uploadUrl) throw new Error("TikTok did not open an upload")

  await send(uploadUrl, blob, video.mime)

  // The upload finishing is not the post existing — TikTok transcodes, and a
  // rejection for length or copyright arrives here rather than above.
  const finished = await pollUntil<Json>(async () => {
    const status = await post(context.token, "/post/publish/status/fetch/", { publish_id: publishId })
    const state = str(status, "status")
    if (state === "PUBLISH_COMPLETE") return status
    if (state === "FAILED") {
      throw new Error(str(status, "fail_reason") ?? "TikTok could not publish that video")
    }
    return null
  })

  // TikTok's own field name has the typo. Both spellings are read because the
  // corrected one is what their newer docs show.
  const ids = finished.publicaly_available_post_id ?? finished.publicly_available_post_id
  const postId = Array.isArray(ids) && ids.length > 0 ? String(ids[0]) : null
  const handle = str(decodeObject(context.account.meta), "handle")

  return {
    remoteId: postId ?? publishId,
    // A private post has no public URL, and TikTok says so by returning no id —
    // a link built anyway would 404 for whoever clicked it.
    url: postId && handle ? `https://www.tiktok.com/@${handle}/video/${postId}` : null,
  }
}
