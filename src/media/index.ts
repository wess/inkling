import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import {
  badRequest,
  conflict,
  del,
  get,
  json,
  notFound,
  parseJson,
  parseMultipart,
  pipeline,
  post,
  put,
  putHeader,
  stream,
} from "atlas/server"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { config } from "../config/index.ts"
import { contains, countRows, paging } from "../db/dialect.ts"
import type { Field } from "../fields/index.ts"
import { body, optionalText } from "../http/index.ts"
import { id } from "../ids/index.ts"
import { decode, decodeArray, decodeObject } from "../json/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { contentTypes, entries, media, settings } from "../schema/index.ts"
import type { StorageDriver } from "../storage/index.ts"
import { drop, get as fetchObject, makeKey, put as putObject } from "../storage/index.ts"
import { now } from "../time/index.ts"

export type MediaRow = {
  id: string
  filename: string
  storage_key: string
  url: string
  mime: string
  size: number
  width: number | null
  height: number | null
  alt: string | null
  caption: string | null
  folder: string | null
  uploaded_by: string | null
  created_at: string
  deleted_at: string | null
}

// The local driver stores a root-relative URL so the row survives a change of
// hostname; it is resolved against PUBLIC_URL here, at read time. S3 URLs are
// already absolute and pass through untouched.
export const publicUrl = (url: string): string =>
  url.startsWith("/") ? `${config.publicUrl.replace(/\/+$/, "")}${url}` : url

export const present = (row: MediaRow) => ({
  id: row.id,
  filename: row.filename,
  url: publicUrl(row.url),
  mime: row.mime,
  size: row.size,
  width: row.width,
  height: row.height,
  alt: row.alt,
  caption: row.caption,
  folder: row.folder,
  uploadedBy: row.uploaded_by,
  createdAt: row.created_at,
  deletedAt: row.deleted_at,
})

// Anything outside this list is served as an attachment. SVG is excluded on
// purpose: browsers parse it as XML and run any script inside it, so an
// inline-rendered SVG upload is a stored XSS against the admin origin.
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
])

// The uploader's `Content-Type` is a claim, and `dispositionFor` below decides
// whether to serve a file inline on this origin — the same origin the admin and
// its session token live on. So the claim is checked against the bytes rather
// than believed.
//
// `x-content-type-options: nosniff` (set by withSecurityHeaders) already stops a
// browser reinterpreting a response, and is the real defence. This is the second
// one, and it is cheap: a file whose header says PNG and whose body is a
// document should not be stored as an image whatever any single header does.
const MAGIC: readonly { readonly mime: string; readonly test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/png", test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mime: "image/webp",
    test: b => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
  },
  { mime: "application/pdf", test: b => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
]

const MARKUP = /^\s*(<!doctype|<html|<head|<body|<script|<svg|<\?xml|<!\[cdata)/i

export const storedMime = (declared: string, bytes: Uint8Array): string => {
  const recognized = MAGIC.find(entry => entry.test(bytes))
  // Recognized wins outright: what the bytes are beats what the upload said.
  if (recognized) return recognized.mime
  if (!INLINE_SAFE.has(declared)) return declared

  // Claims an inline-safe type we could not confirm. Serving a document inline
  // under a borrowed content type is the whole attack, so anything that opens
  // like markup is demoted to a download.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512))
  return MARKUP.test(head) ? "application/octet-stream" : declared
}

const dispositionFor = (mime: string, filename: string): { contentType: string; disposition: string } =>
  INLINE_SAFE.has(mime)
    ? { contentType: mime, disposition: `inline; filename="${filename.replace(/"/g, "")}"` }
    : { contentType: "application/octet-stream", disposition: `attachment; filename="${filename.replace(/"/g, "")}"` }

// PNG/JPEG/GIF/WebP dimensions from the file header. Enough to let the editor
// lay out an image without pulling in a native image library.
const readDimensions = (bytes: Uint8Array, mime: string): { width: number; height: number } | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (mime === "image/png" && bytes.length > 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) }
    }
    if (mime === "image/gif" && bytes.length > 10) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
    }
    if (mime === "image/webp" && bytes.length > 30) {
      // VP8X form carries a 24-bit canvas size at offset 24.
      const chunk = String.fromCharCode(...bytes.slice(12, 16))
      if (chunk === "VP8X") {
        // Canvas size is two 24-bit little-endian values, each stored minus one.
        const uint24 = (at: number) =>
          1 + ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16))
        return { width: uint24(24), height: uint24(27) }
      }
    }
    if (mime === "image/jpeg") {
      let offset = 2
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) break
        const marker = bytes[offset + 1] as number
        const length = view.getUint16(offset + 2)
        // SOF0..SOF15, skipping the four that aren't frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
        }
        offset += 2 + length
      }
    }
  } catch {
    return null
  }
  return null
}

const includesMedia = (fields: readonly Field[], data: Record<string, unknown>, mediaId: string): boolean => {
  for (const field of fields) {
    const value = data[field.key]
    if (field.type === "media" && value === mediaId) return true
    if (field.type === "gallery" && Array.isArray(value) && value.includes(mediaId)) return true
    if (field.type === "list" && field.fields && Array.isArray(value)) {
      for (const item of value) {
        if (
          typeof item === "object" &&
          item !== null &&
          includesMedia(field.fields, item as Record<string, unknown>, mediaId)
        ) {
          return true
        }
      }
    }
  }
  return false
}

const mediaUsage = async (db: Connection, mediaId: string): Promise<{ id: string; title: string }[]> => {
  const types = await db.all<{ id: string; fields: string }>(from(contentTypes).select("id", "fields"))
  const fieldsByType = new Map(types.map(type => [type.id, decodeArray<Field>(type.fields)]))
  const activeEntries = await db.all<{ id: string; title: string; content_type_id: string; data: string }>(
    from(entries)
      .select("id", "title", "content_type_id", "data")
      .where(q => q("deleted_at").isNull()),
  )
  const entryUsage = activeEntries
    .filter(entry => includesMedia(fieldsByType.get(entry.content_type_id) ?? [], decodeObject(entry.data), mediaId))
    .map(entry => ({ id: entry.id, title: entry.title }))
  const settingRows = await db.all<{ key: string; value: string }>(
    from(settings)
      .select("key", "value")
      .where(q => q("scope").equals("site"))
      .where(q => q("key").inList(["logoId", "faviconId", "socialImageId"])),
  )
  const settingUsage = settingRows
    .filter(setting => decode<string | null>(setting.value, null) === mediaId)
    .map(setting => ({ id: `setting:${setting.key}`, title: `Site setting: ${setting.key}` }))
  return [...entryUsage, ...settingUsage]
}

const assertMediaUnused = async (db: Connection, mediaId: string): Promise<void> => {
  const usage = await mediaUsage(db, mediaId)
  if (usage.length === 0) return
  throw conflict(
    `This file is used by ${usage.length} ${usage.length === 1 ? "entry" : "entries"}. Remove it there before deleting it.`,
    {
      code: "IN_USE",
      details: { entryCount: usage.length, entries: usage.slice(0, 10) },
    },
  )
}

export const mediaRoutes = (db: Connection, store: StorageDriver, hooks: Hooks): Route[] => {
  const read = pipeline(requireAuth(db), requireCan(can.readContent, "read content"))
  const write = pipeline(requireAuth(db), requireCan(can.manageMedia, "manage media"), parseJson)
  const uploads = pipeline(requireAuth(db), requireCan(can.manageMedia, "manage media"), parseMultipart)
  const act = pipeline(requireAuth(db), requireCan(can.manageMedia, "manage media"))

  return [
    get(
      "/media",
      read(async c => {
        const { limit, offset, page } = paging(c.query)

        let query = from("media").where(q => q("deleted_at").isNull())
        if (c.query.folder) query = query.where(q => q("folder").equals(c.query.folder as string))
        if (c.query.q) query = query.where(q => q.raw(contains(db, "filename", c.query.q as string)))
        // `type=image` matches image/*, and so on for video/audio.
        if (c.query.type) query = query.where(q => q("mime").like(`${c.query.type}/%`))

        const rows = await db.all<MediaRow>(query.orderBy("created_at", "DESC").limit(limit).offset(offset))

        return json(c, 200, {
          data: rows.map(present),
          meta: { total: await countRows(db, query.select("COUNT(*) as total")), page, limit },
        })
      }),
    ),

    get(
      "/media/:id",
      read(async c => {
        const row = await db.one<MediaRow>(
          from(media)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNull()),
        )
        if (!row) throw notFound("Media not found")
        return json(c, 200, present(row))
      }),
    ),

    post(
      "/media",
      uploads(async c => {
        // atlas/server's parseMultipart splits the body into text `fields` and
        // binary `files` rather than one flat record.
        const { fields, files } = (c.body ?? {}) as {
          fields?: Record<string, string>
          files?: Record<string, Blob>
        }
        const form = fields ?? {}
        const file = files?.file

        if (!file) throw badRequest("Attach a file under the `file` field", { code: "NO_FILE" })
        if (file.size === 0) throw badRequest("File is empty", { code: "EMPTY_FILE" })
        if (file.size > config.maxUploadBytes) {
          throw badRequest(`File is larger than the ${Math.floor(config.maxUploadBytes / 1_048_576)}MB limit`, {
            code: "TOO_LARGE",
          })
        }

        const identity = auth(c)
        // Bun hands back File instances for file parts, but the parser types
        // them as Blob — read the name defensively rather than casting.
        const filename = (file as File).name || "upload"
        const key = makeKey(filename)
        const bytes = new Uint8Array(await file.arrayBuffer())
        const mime = storedMime(file.type || "application/octet-stream", bytes)
        const dimensions = mime.startsWith("image/") ? readDimensions(bytes, mime) : null

        const { url } = await putObject(store, key, bytes, mime)

        const row: MediaRow = {
          id: id(),
          filename,
          storage_key: key,
          url,
          mime,
          size: file.size,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          alt: typeof form.alt === "string" ? form.alt : null,
          caption: typeof form.caption === "string" ? form.caption : null,
          folder: typeof form.folder === "string" && form.folder ? form.folder : null,
          uploaded_by: identity.id,
          created_at: now(),
          deleted_at: null,
        }

        try {
          await db.execute(from(media).insert(row))
        } catch (error) {
          await drop(store, key).catch(() => {})
          throw error
        }
        await hooks.emit("media.afterUpload", { media: row, identity })

        return json(c, 201, present(row))
      }),
    ),

    put(
      "/media/:id",
      write(async c => {
        const row = await db.one<MediaRow>(
          from(media)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNull()),
        )
        if (!row) throw notFound("Media not found")

        const input = body(c)
        const changes = {
          alt: input.alt === undefined ? row.alt : optionalText(input, "alt"),
          caption: input.caption === undefined ? row.caption : optionalText(input, "caption"),
          folder: input.folder === undefined ? row.folder : optionalText(input, "folder"),
        }

        await db.execute(
          from(media)
            .update(changes)
            .where(q => q("id").equals(row.id)),
        )
        return json(c, 200, present({ ...row, ...changes }))
      }),
    ),

    del(
      "/media/:id",
      act(async c => {
        const row = await db.one<MediaRow>(
          from(media)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNull()),
        )
        if (!row) throw notFound("Media not found")

        await assertMediaUnused(db, row.id)

        // Soft-delete only. The blob is what makes recovery possible — purging
        // happens in the trash route after another usage check.
        await db.execute(
          from(media)
            .update({ deleted_at: now() })
            .where(q => q("id").equals(row.id)),
        )
        await hooks.emit("media.afterDelete", { media: row, identity: auth(c) })

        return json(c, 200, { deleted: true, id: row.id })
      }),
    ),

    del(
      "/trash/media/:id",
      pipeline(
        requireAuth(db),
        requireCan(can.manageTypes, "permanently delete media"),
      )(async c => {
        const row = await db.one<MediaRow>(
          from(media)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNotNull()),
        )
        if (!row) throw notFound("Media not found in trash")

        await assertMediaUnused(db, row.id)

        await db.execute(
          from(media)
            .where(q => q("id").equals(row.id))
            .del(),
        )
        // The row is already gone; a storage failure here is not worth failing
        // the request over, it just leaves an orphaned object.
        await drop(store, row.storage_key).catch(() => {})

        return json(c, 200, { purged: true, id: row.id })
      }),
    ),

    get(
      "/trash/media",
      act(async c => {
        const { limit, offset } = paging(c.query)
        const rows = await db.all<MediaRow>(
          from(media)
            .where(q => q("deleted_at").isNotNull())
            .orderBy("deleted_at", "DESC")
            .limit(limit)
            .offset(offset),
        )
        return json(c, 200, { data: rows.map(present) })
      }),
    ),

    post(
      "/trash/media/:id/restore",
      act(async c => {
        const row = await db.one<MediaRow>(
          from(media)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNotNull()),
        )
        if (!row) throw notFound("Media not found in trash")
        await db.execute(
          from(media)
            .update({ deleted_at: null })
            .where(q => q("id").equals(row.id)),
        )
        return json(c, 200, present({ ...row, deleted_at: null }))
      }),
    ),
  ]
}

// Split out of mediaRoutes because it is the only media route that is public,
// and public routes stay at the root of the origin while session-gated ones move
// under /api. Media URLs are also stored in rows and resolved against
// PUBLIC_URL, so this path has to stay put regardless of how the admin is
// mounted.
export const mediaFileRoutes = (db: Connection, store: StorageDriver): Route[] => {
  return [
    // Binary read-back for the local driver. Wildcard because storage keys
    // contain slashes. Public by design: media is what a website renders, and
    // keys carry 8 bytes of randomness so they aren't guessable.
    get("/media/file/*", async c => {
      const key = c.path.replace(/^\/media\/file\//, "")
      if (!key || key.includes("..")) throw notFound("Media not found")

      const row = await db.one<MediaRow>(
        from(media)
          .where(q => q("storage_key").equals(key))
          .where(q => q("deleted_at").isNull()),
      )
      if (!row) throw notFound("Media not found")

      const object = await fetchObject(store, key)
      if (!object) throw notFound("Media not found")

      const { contentType, disposition } = dispositionFor(row.mime, row.filename)
      const withType = putHeader(c, "content-type", contentType)
      const withDisposition = putHeader(withType, "content-disposition", disposition)
      const cached = putHeader(withDisposition, "cache-control", "public, max-age=31536000, immutable")

      // The whole point of a headless CMS's media is that another origin embeds
      // it. withSecurityHeaders' default of `same-site` would make every <img>
      // on a consuming site fail — and fail invisibly, since the response is a
      // perfectly good 200 that the browser then refuses to paint. It only
      // fills headers that are absent, so setting it here wins.
      const embeddable = putHeader(cached, "cross-origin-resource-policy", "cross-origin")

      return stream(embeddable, 200, object)
    }),
  ]
}
