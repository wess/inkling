import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { rows as query } from "../../src/db/dialect.ts"
import { decodeObject } from "../../src/json/index.ts"

// Reading the plugin's own content types back out of `entries`.
//
// Every view here is *editorial* rather than public, so none of them filter on
// `status = 'published'` the way a delivery route would — a post that is still
// a draft is precisely what a queue is for. Soft-deleted rows are excluded,
// because those are in the trash and an editor has already said so.
//
// Queries use Atlas's string-table form and go through `rows` from
// src/db/dialect.ts: joining `content_types` to filter by type name is exactly
// the case `from(schema)` cannot express.

type EntryRow = {
  id: string
  slug: string
  title: string
  data: string
  status: string
  updated_at: string
}

export type Item = {
  readonly id: string
  readonly slug: string
  readonly title: string
  readonly status: string
  readonly updatedAt: string
  readonly data: Record<string, unknown>
}

// A ceiling rather than paging: these views are a working queue and a quarterly
// report, both of which stop being readable long before they stop being
// possible. A shop with more than this many scheduled posts has a different
// problem than a missing page 2.
const CEILING = 2_000

export const loadType = async (db: Connection, type: string, limit = CEILING): Promise<Item[]> => {
  const found = await query<EntryRow>(
    db,
    from("entries", "e")
      .join("content_types", "ct.id = e.content_type_id", "ct")
      .select("e.id", "e.slug", "e.title", "e.data", "e.status", "e.updated_at")
      .where(q => q("ct.name").equals(type))
      .where(q => q("e.deleted_at").isNull())
      .orderBy("e.updated_at", "DESC")
      .limit(Math.min(limit, CEILING)),
  )

  return found.map(row => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    updatedAt: row.updated_at,
    data: decodeObject(row.data),
  }))
}

export const byId = (items: readonly Item[]): Map<string, Item> => new Map(items.map(item => [item.id, item]))

// Reference fields hold an entry id — or an array of them when `multiple` is
// set, which none of this plugin's are, but a model can change under stored
// data and a crash in the queue is a worse answer than the first id.
export const refId = (value: unknown): string | null => {
  if (typeof value === "string" && value !== "") return value
  if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  return null
}

export const refTitle = (value: unknown, lookup: Map<string, Item>, fallback = "—"): string => {
  const id = refId(value)
  return (id && lookup.get(id)?.title) || fallback
}

export const text = (value: unknown): string => (typeof value === "string" ? value : "")

export const num = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// One line of a caption, for a table cell. Newlines become spaces first, or a
// caption written as a poem renders as a single very tall row.
export const preview = (value: unknown, length = 80): string => {
  const flat = text(value).replace(/\s+/g, " ").trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}
