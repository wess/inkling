import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import { badRequest, get, json, notFound, pipeline, post, putHeader, unauthorized } from "atlas/server"
import { allows, auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { config } from "../config/index.ts"
import { byId as typeById } from "../contenttypes/index.ts"
import type { EntryRow } from "../entries/index.ts"
import type { Field } from "../fields/index.ts"
import { cors, noStore } from "../http/index.ts"
import { decodeArray, decodeObject } from "../json/index.ts"
import type { MediaRow } from "../media/index.ts"
import { present as presentMedia } from "../media/index.ts"
import { entries, media } from "../schema/index.ts"
import { now } from "../time/index.ts"

// Content types can carry a `preview_url` template, but until now there was no
// way for the consuming site to actually *fetch* an unpublished entry — the
// delivery API returns published content only, by design, and handing a website
// an admin session to work around that would be worse than the problem.
//
// A preview token is the narrow answer: it names exactly one entry, expires
// within the hour, and is signed rather than stored. Signed because the whole
// value of a preview link is that it can be pasted to someone who has no
// account, and a row per share is bookkeeping for something meant to be
// disposable. Nothing is revocable, which is why the lifetime is short.

const TTL_SECONDS = 3_600

const encode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

// Return type is pinned to a plain ArrayBuffer because WebCrypto's BufferSource
// rejects the possibly-shared buffer type a bare Uint8Array infers.
//
// Null rather than a throw: the input is a path segment anyone can type, and
// `atob` raises on a character outside the alphabet. Letting that escape turned
// `/preview/@@@.@@@` into a 500 — an unhandled error where the honest answer is
// the same "this link is invalid" every other bad token gets.
const decode = (value: string): Uint8Array<ArrayBuffer> | null => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  let binary: string
  try {
    binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="))
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const signingKey = async (): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(config.secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])

type Claim = { readonly entryId: string; readonly expiresAt: number }

// `<base64url(payload)>.<base64url(hmac)>` — a JWT would carry a header nobody
// reads and a library nobody needs for two fields.
export const mintPreviewToken = async (
  entryId: string,
  ttlSeconds = TTL_SECONDS,
): Promise<Claim & { token: string }> => {
  const claim: Claim = { entryId, expiresAt: Date.now() + ttlSeconds * 1000 }
  const payload = encode(new TextEncoder().encode(JSON.stringify(claim)))
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), new TextEncoder().encode(payload))
  return { ...claim, token: `${payload}.${encode(new Uint8Array(signature))}` }
}

export const readPreviewToken = async (token: string): Promise<Claim | null> => {
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return null

  const mac = decode(signature)
  const body = decode(payload)
  if (!mac || !body) return null

  // Verified before parsing, so a forged payload is never interpreted.
  const ok = await crypto.subtle
    .verify("HMAC", await signingKey(), mac, new TextEncoder().encode(payload))
    .catch(() => false)
  if (!ok) return null

  try {
    const claim = JSON.parse(new TextDecoder().decode(body)) as Claim
    if (typeof claim.entryId !== "string" || typeof claim.expiresAt !== "number") return null
    return claim.expiresAt <= Date.now() ? null : claim
  } catch {
    return null
  }
}

// Fills the same tokens the content type's `preview_url` template accepts, so the
// admin's "Preview" button lands on the consuming site's own route rather than on
// a URL this module invented.
const resolveTemplate = (template: string, entry: EntryRow, typeName: string, siteUrl: string): string => {
  const filled = template
    .replaceAll("{id}", entry.id)
    .replaceAll("{slug}", entry.slug)
    .replaceAll("{locale}", entry.locale)
    .replaceAll("{type}", typeName)
  return filled.startsWith("/") ? `${siteUrl.replace(/\/+$/, "")}${filled}` : filled
}

export const previewRoutes = (db: Connection): Route[] => {
  const issue = pipeline(requireAuth(db), requireCan(can.writeContent, "share a preview"))

  return [
    post(
      "/entries/:id/preview",
      issue(async c => {
        const row = await db.one<EntryRow>(
          from(entries)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNull()),
        )
        if (!row) throw notFound("Entry not found")

        // An author may share their own drafts; editors may share anything. Same
        // rule the editor itself applies, restated because a preview link
        // outlives the session that made it.
        const identity = auth(c)
        if (!allows(identity, can.publishContent) && row.author_id !== identity.id) {
          throw badRequest("You can only share previews of entries you authored", { code: "NOT_YOURS" })
        }

        const type = await typeById(db, row.content_type_id)
        const minted = await mintPreviewToken(row.id)

        // Two URLs: the API endpoint a headless consumer can call, and — when the
        // type declares a template — the page on the real site.
        // Root, not /api — the link is meant to be pasted to someone who has no
        // session, so it must not sit behind the admin prefix.
        const apiUrl = `${config.publicUrl.replace(/\/+$/, "")}/preview/${minted.token}`
        const siteUrl = type?.preview_url
          ? `${resolveTemplate(type.preview_url, row, type.name, config.publicUrl)}${
              type.preview_url.includes("?") ? "&" : "?"
            }preview=${minted.token}`
          : null

        return json(noStore(c), 201, {
          token: minted.token,
          expiresAt: new Date(minted.expiresAt).toISOString(),
          url: apiUrl,
          siteUrl,
        })
      }),
    ),
  ]
}

// Kept apart from previewRoutes because this one is public: the whole point is a
// link someone without an account can open, so it stays at the root of the
// origin while the route that mints it lives under /api with the rest of the
// session-gated surface.
export const previewPublicRoutes = (db: Connection): Route[] => {
  return [
    // Public by token. Returns the entry whatever its status — that is the entire
    // point — but only the one entry the token names, and only until it expires.
    get(
      "/preview/:token",
      pipeline(cors)(async c => {
        const claim = await readPreviewToken(c.params.token ?? "")
        if (!claim) throw unauthorized("This preview link is invalid or has expired", { code: "BAD_PREVIEW" })

        const row = await db.one<EntryRow>(
          from(entries)
            .where(q => q("id").equals(claim.entryId))
            .where(q => q("deleted_at").isNull()),
        )
        if (!row) throw notFound("Entry not found")

        const type = await typeById(db, row.content_type_id)
        const fields = type ? decodeArray<Field>(type.fields) : []
        const data = decodeObject(row.data)

        // Media is expanded so a preview renders its images, matching what the
        // delivery API does. References are left as ids: expanding them would mean
        // deciding whether a *referenced* draft is also in scope, and one token
        // should mean one entry.
        const mediaIds = fields
          .flatMap(field => {
            const value = data[field.key]
            if (field.type === "media" && typeof value === "string") return [value]
            if (field.type === "gallery" && Array.isArray(value))
              return value.filter((v): v is string => typeof v === "string")
            return []
          })
          .filter((value, index, all) => all.indexOf(value) === index)

        const mediaRows =
          mediaIds.length === 0
            ? []
            : await db.all<MediaRow>(
                from(media)
                  .where(q => q("id").inList(mediaIds))
                  .where(q => q("deleted_at").isNull()),
              )
        const mediaById = new Map(mediaRows.map(item => [item.id, item]))

        const expanded: Record<string, unknown> = { ...data }
        for (const field of fields) {
          const value = data[field.key]
          if (field.type === "media") {
            const found = typeof value === "string" ? mediaById.get(value) : undefined
            expanded[field.key] = found ? presentMedia(found) : null
          } else if (field.type === "gallery" && Array.isArray(value)) {
            expanded[field.key] = value
              .map(item => (typeof item === "string" ? mediaById.get(item) : undefined))
              .filter((item): item is MediaRow => item !== undefined)
              .map(presentMedia)
          }
        }

        const body = {
          data: {
            id: row.id,
            type: type?.name ?? null,
            slug: row.slug,
            title: row.title,
            status: row.status,
            locale: row.locale,
            updatedAt: row.updated_at,
            data: expanded,
          },
          meta: { preview: true, expiresAt: new Date(claim.expiresAt).toISOString(), at: now() },
        }

        // Never cached and never indexed: this is unpublished content behind a link
        // that is meant to be pasted into a chat window.
        const noRobots = putHeader(noStore(c), "x-robots-tag", "noindex, nofollow")
        return json(noRobots, 200, body)
      }),
    ),
  ]
}
