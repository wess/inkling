import type { PublishContext, Published } from "./index.ts"
import { bearer, nested, option, readJson, str } from "./index.ts"

// YouTube, through the Data API's resumable upload.
//
// Resumable rather than simple because a video is the whole payload here: the
// simple endpoint takes the bytes and the metadata in one multipart request,
// which means a connection that drops at 90% has nothing to resume from. The
// two-step version costs one extra round trip and turns the failure into
// something that could be retried.
//
// A YouTube title is not a caption. It is a separate, mandatory, 100-character
// field, and the caption is the description — so the option falls back through
// the post's title before it reaches the caption's first line.

const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos"

const PRIVACY = new Set(["public", "unlisted", "private"])

const titleFor = (context: PublishContext): string => {
  const chosen = option(context.options, "title") || context.title || context.caption.split("\n")[0] || "Untitled"
  return chosen.slice(0, 100)
}

export const publish = async (context: PublishContext): Promise<Published> => {
  const video = context.media.find(item => item.isVideo)
  if (!video) throw new Error("YouTube needs a video")

  const blob = await video.bytes()
  const privacy = option(context.options, "privacy", "private")
  const tags = option(context.options, "tags")
    .split(",")
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 30)

  const metadata = {
    snippet: {
      title: titleFor(context),
      description: [context.caption, context.link]
        .filter(part => part && part.trim() !== "")
        .join("\n\n")
        .slice(0, 5000),
      ...(tags.length > 0 ? { tags } : {}),
    },
    status: {
      privacyStatus: PRIVACY.has(privacy) ? privacy : "private",
      selfDeclaredMadeForKids: false,
    },
  }

  const start = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      ...bearer(context.token),
      "content-type": "application/json",
      "x-upload-content-type": video.mime,
      "x-upload-content-length": String(blob.size),
    },
    body: JSON.stringify(metadata),
  })

  // A rejected metadata step answers with JSON and no Location — readJson turns
  // that into Google's own sentence, which is where quota and scope errors say
  // what they are.
  const session = start.headers.get("location")
  if (!session) {
    await readJson(start)
    throw new Error("YouTube did not open an upload session")
  }

  const payload = await readJson(
    await fetch(session, {
      method: "PUT",
      headers: { "content-type": video.mime, "content-length": String(blob.size) },
      body: blob,
    }),
  )

  const id = str(payload, "id")
  if (!id) throw new Error("YouTube accepted the upload but returned no video id")

  // A video is live as soon as this returns; the processing that follows
  // affects available resolutions, not whether the URL works.
  const status = nested(payload, "status")
  const failure = str(status, "failureReason") ?? str(status, "rejectionReason")
  if (failure) throw new Error(`YouTube rejected the video: ${failure}`)

  return { remoteId: id, url: `https://youtu.be/${id}` }
}
