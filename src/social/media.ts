import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { rows as query } from "../db/dialect.ts"
import type { MediaRow } from "../media/index.ts"
import { publicUrl } from "../media/index.ts"
import type { StorageDriver } from "../storage/index.ts"
import { get as fetchObject } from "../storage/index.ts"

// What a publisher is handed instead of a media id.
//
// Networks split cleanly in two about how they want a file, and neither half
// can be served by the other. Facebook takes a URL and fetches it themselves;
// X, YouTube, and TikTok want the bytes pushed at them. So this carries both,
// and `bytes()` is a function rather than a field because a video is tens of
// megabytes and a post going to four networks would otherwise hold four copies
// of it in memory before the first request left.

export type Attachment = {
  readonly id: string
  readonly filename: string
  readonly mime: string
  readonly size: number
  readonly width: number | null
  readonly height: number | null
  readonly alt: string | null
  // Absolute, and reachable by the network — which is to say, only as reachable
  // as PUBLIC_URL is. A localhost install cannot use the URL-fetching networks,
  // and says so rather than watching Facebook time out.
  readonly url: string
  readonly isVideo: boolean
  readonly isImage: boolean
  readonly bytes: () => Promise<Blob>
}

const isVideoMime = (mime: string): boolean => mime.startsWith("video/")
const isImageMime = (mime: string): boolean => mime.startsWith("image/")

// A URL a network's servers can fetch. Local-only origins are the common case
// in development and the one failure that looks like the network's fault.
export const reachable = (url: string): boolean => {
  try {
    const host = new URL(url).hostname
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && !host.endsWith(".local")
  } catch {
    return false
  }
}

const attach = (row: MediaRow, store: StorageDriver): Attachment => ({
  id: row.id,
  filename: row.filename,
  mime: row.mime,
  size: row.size,
  width: row.width,
  height: row.height,
  alt: row.alt,
  url: publicUrl(row.url),
  isVideo: isVideoMime(row.mime),
  isImage: isImageMime(row.mime),
  bytes: async () => {
    const object = await fetchObject(store, row.storage_key)
    if (!object) throw new Error(`"${row.filename}" is no longer in storage`)
    return new Response(object).blob()
  },
})

// Resolves ids in the order they were given, which is the order they were
// arranged in the composer — a carousel's first image is a decision.
// Soft-deleted media is skipped rather than failing the whole post, and the
// caller compares counts when the difference matters.
export const attachments = async (
  db: Connection,
  store: StorageDriver,
  ids: readonly string[],
): Promise<Attachment[]> => {
  if (ids.length === 0) return []

  const found = await query<MediaRow>(
    db,
    from("media", "m")
      .where(q => q("m.id").inList([...ids]))
      .where(q => q("m.deleted_at").isNull()),
  )

  const byId = new Map(found.map(row => [row.id, row]))
  return ids.flatMap(id => {
    const row = byId.get(id)
    return row ? [attach(row, store)] : []
  })
}

export type Shape = { readonly images: number; readonly videos: number }

export const shapeOf = (items: readonly Attachment[]): Shape => ({
  images: items.filter(item => item.isImage).length,
  videos: items.filter(item => item.isVideo).length,
})
