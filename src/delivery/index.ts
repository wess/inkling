import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn, Route } from "@atlas/server"
import { forbidden, get, json, notFound, options, pipeline, putHeader } from "@atlas/server"
import type { ContentTypeRow } from "../contenttypes/index.ts"
import { byName as typeByName } from "../contenttypes/index.ts"
// Aliased — the list route already binds `rows` to its own page of entries.
import { countRows, paging, rows as selectRows } from "../db/dialect.ts"
import type { EntryRow } from "../entries/index.ts"
import type { Field } from "../fields/index.ts"
import { cors, preflight } from "../http/index.ts"
import { decodeArray, decodeObject } from "../json/index.ts"
import type { KeyIdentity } from "../keys/index.ts"
import { keyAllows, keyIdentity, requireApiKey } from "../keys/index.ts"
import type { MediaRow } from "../media/index.ts"
import { present as presentMedia, publicUrl } from "../media/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { contentTypes, entries, media, menus, terms as termsTable } from "../schema/index.ts"
import { siteSettings } from "../settings/index.ts"
import { termsForEntries } from "../taxonomy/index.ts"
import { now } from "../time/index.ts"

// The public, read-only face of the CMS — what a website actually calls.
// Everything here is key-authenticated, returns published content only, and
// never exposes drafts, authors' emails, or internal ids beyond entry ids.

// A byline is the one thing a consuming site legitimately needs about a user,
// so `?include=author` returns the display name and avatar and nothing else.
// Email, role, and account timestamps never cross this boundary.
type PublicAuthor = { readonly name: string; readonly avatarUrl: string | null }

const authorsForEntries = async (db: Connection, rows: readonly EntryRow[]): Promise<Map<string, PublicAuthor>> => {
  const ids = [...new Set(rows.map(row => row.author_id).filter((value): value is string => Boolean(value)))]
  if (ids.length === 0) return new Map()

  const found = await selectRows<{ id: string; name: string; avatar_id: string | null }>(
    db,
    from("users", "u")
      .select("u.id", "u.name", "u.avatar_id")
      .where(q => q("u.id").inList(ids))
      .where(q => q("u.deleted_at").isNull()),
  )

  const avatarIds = found.map(row => row.avatar_id).filter((value): value is string => Boolean(value))
  const avatars = new Map<string, MediaRow>()
  if (avatarIds.length > 0) {
    for (const row of await db.all<MediaRow>(from(media).where(q => q("id").inList([...new Set(avatarIds)])))) {
      avatars.set(row.id, row)
    }
  }

  const byUser = new Map<string, PublicAuthor>()
  for (const row of found) {
    const avatar = row.avatar_id ? avatars.get(row.avatar_id) : undefined
    byUser.set(row.id, { name: row.name, avatarUrl: avatar ? publicUrl(avatar.url) : null })
  }

  const byEntry = new Map<string, PublicAuthor>()
  for (const row of rows) {
    const author = row.author_id ? byUser.get(row.author_id) : undefined
    if (author) byEntry.set(row.id, author)
  }
  return byEntry
}

type Expansion = {
  readonly mediaById: Map<string, MediaRow>
  readonly entriesById: Map<string, EntryRow>
}

const collectRefs = (
  fields: readonly Field[],
  data: Record<string, unknown>,
): { media: string[]; entries: string[] } => {
  const mediaIds: string[] = []
  const entryIds: string[] = []

  const walk = (defs: readonly Field[], values: Record<string, unknown>) => {
    for (const field of defs) {
      const value = values[field.key]
      if (value === null || value === undefined) continue

      if (field.type === "media" && typeof value === "string") mediaIds.push(value)
      else if (field.type === "gallery" && Array.isArray(value)) {
        mediaIds.push(...value.filter((v): v is string => typeof v === "string"))
      } else if (field.type === "reference") {
        if (typeof value === "string") entryIds.push(value)
        else if (Array.isArray(value)) entryIds.push(...value.filter((v): v is string => typeof v === "string"))
      } else if (field.type === "list" && Array.isArray(value) && field.fields) {
        for (const item of value) walk(field.fields, (item ?? {}) as Record<string, unknown>)
      }
    }
  }

  walk(fields, data)
  return { media: [...new Set(mediaIds)], entries: [...new Set(entryIds)] }
}

// Media and reference fields are replaced with the objects they point at, so a
// consuming site renders an entry without a second round trip per image.
const expand = (fields: readonly Field[], data: Record<string, unknown>, refs: Expansion): Record<string, unknown> => {
  const out: Record<string, unknown> = {}

  for (const field of fields) {
    const value = data[field.key]

    if (field.type === "media") {
      const found = typeof value === "string" ? refs.mediaById.get(value) : undefined
      out[field.key] = found ? presentMedia(found) : null
    } else if (field.type === "gallery") {
      const list = Array.isArray(value) ? value : []
      out[field.key] = list
        .map(item => (typeof item === "string" ? refs.mediaById.get(item) : undefined))
        .filter((item): item is MediaRow => item !== undefined)
        .map(presentMedia)
    } else if (field.type === "reference") {
      const resolve = (ref: unknown) => {
        const found = typeof ref === "string" ? refs.entriesById.get(ref) : undefined
        return found ? { id: found.id, slug: found.slug, title: found.title, data: decodeObject(found.data) } : null
      }
      out[field.key] = Array.isArray(value) ? value.map(resolve).filter(Boolean) : resolve(value)
    } else if (field.type === "list" && field.fields) {
      const list = Array.isArray(value) ? value : []
      out[field.key] = list.map(item => expand(field.fields as Field[], (item ?? {}) as Record<string, unknown>, refs))
    } else {
      out[field.key] = value ?? null
    }
  }

  return out
}

const loadExpansions = async (
  db: Connection,
  mediaIds: string[],
  entryIds: string[],
  identity: KeyIdentity,
): Promise<Expansion> => {
  const mediaRows =
    mediaIds.length === 0
      ? []
      : await db.all<MediaRow>(
          from(media)
            .where(q => q("id").inList(mediaIds))
            .where(q => q("deleted_at").isNull()),
        )

  // Referenced entries must be published too — a reference is not a way to leak
  // a draft into the public API.
  const allowedTypeIds =
    identity.scopes.length === 0
      ? null
      : await db.all<{ id: string }>(
          from(contentTypes)
            .select("id")
            .where(q => q("name").inList(identity.scopes)),
        )

  const entryRows =
    entryIds.length === 0 || allowedTypeIds?.length === 0
      ? []
      : await db.all<EntryRow>(
          from(entries)
            .where(q => q("id").inList(entryIds))
            .where(q => q("status").equals("published"))
            .where(q => q("deleted_at").isNull()),
        )

  const scopedEntryRows = allowedTypeIds
    ? entryRows.filter(row => allowedTypeIds.some(type => type.id === row.content_type_id))
    : entryRows

  return {
    mediaById: new Map(mediaRows.map(row => [row.id, row])),
    entriesById: new Map(scopedEntryRows.map(row => [row.id, row])),
  }
}

const publishedQuery = (typeId: string) =>
  from("entries")
    .where(q => q("content_type_id").equals(typeId))
    .where(q => q("status").equals("published"))
    .where(q => q("deleted_at").isNull())
    .where(q => q("published_at").lessThanOrEqual(now()))

// Delivery responses depend on credentials, so a browser may cache its own
// reads briefly but a CDN or proxy must never reuse one key's response for
// another caller. Vary also keeps separate credentials apart in user-agent
// caches when a developer switches between keys.
const privateCache = (c: Conn, maxAge: number): Conn =>
  putHeader(putHeader(c, "cache-control", `private, max-age=${maxAge}`), "vary", "origin, x-api-key, authorization")

export const deliveryRoutes = (db: Connection, hooks: Hooks): Route[] => {
  const guard = pipeline(cors, requireApiKey(db))

  const loadType = async (name: string, c: Parameters<typeof keyIdentity>[0]): Promise<ContentTypeRow> => {
    const type = await typeByName(db, name)
    if (!type) throw notFound(`Content type "${name}" not found`)
    if (!keyAllows(keyIdentity(c), name)) {
      throw forbidden(`This API key does not include "${name}"`, { code: "OUT_OF_SCOPE" })
    }
    return type
  }

  // One entry -> its public JSON, with references expanded, terms attached,
  // and a final pass through the `delivery.entry` filter so plugins can shape
  // what consumers see.
  const shape = async (
    type: ContentTypeRow,
    entryRows: readonly EntryRow[],
    include: ReadonlySet<string>,
    identity: KeyIdentity,
  ): Promise<Record<string, unknown>[]> => {
    if (entryRows.length === 0) return []

    const includeTerms = include.has("terms")
    const includeAuthor = include.has("author")

    const fields = decodeArray<Field>(type.fields)
    const wanted = { media: [] as string[], entries: [] as string[] }
    for (const row of entryRows) {
      const found = collectRefs(fields, decodeObject(row.data))
      wanted.media.push(...found.media)
      wanted.entries.push(...found.entries)
    }

    const refs = await loadExpansions(db, [...new Set(wanted.media)], [...new Set(wanted.entries)], identity)
    const termsByEntry = includeTerms
      ? await termsForEntries(
          db,
          entryRows.map(r => r.id),
        )
      : new Map()
    const authorByEntry = includeAuthor ? await authorsForEntries(db, entryRows) : new Map<string, PublicAuthor>()

    const shaped = []
    for (const row of entryRows) {
      const payload: Record<string, unknown> = {
        id: row.id,
        slug: row.slug,
        title: row.title,
        locale: row.locale,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
        data: expand(fields, decodeObject(row.data), refs),
        ...(includeTerms ? { terms: termsByEntry.get(row.id) ?? [] } : {}),
        ...(includeAuthor ? { author: authorByEntry.get(row.id) ?? null } : {}),
      }
      const filtered = await hooks.filter("delivery.entry", { payload, type, raw: row })
      shaped.push(filtered.payload)
    }
    return shaped
  }

  // `?include=terms,author` — a set, so the two are independent rather than the
  // single-value comparison this used to be.
  const included = (value: string | undefined): ReadonlySet<string> =>
    new Set(
      (value ?? "")
        .split(",")
        .map(part => part.trim())
        .filter(Boolean),
    )

  return [
    options("/content/*", pipeline(cors)(preflight)),
    options("/site/*", pipeline(cors)(preflight)),

    get(
      "/content/:type",
      guard(async c => {
        const type = await loadType(c.params.type ?? "", c)
        const { limit, offset, page } = paging(c.query, 20, 100)

        let query = publishedQuery(type.id)
        if (c.query.locale) query = query.where(q => q("locale").equals(c.query.locale as string))

        // ?term=<slug> filters to entries carrying that term.
        if (c.query.term) {
          const term = await db.one<{ id: string }>(
            from(termsTable)
              .select("id")
              .where(q => q("slug").equals(c.query.term as string)),
          )
          if (!term) return json(c, 200, { data: [], meta: { total: 0, page, limit } })
          const tagged = await db.all<{ entry_id: string }>(
            from("entry_terms")
              .select("entry_id")
              .where(q => q("term_id").equals(term.id)),
          )
          const ids = tagged.map(t => t.entry_id)
          if (ids.length === 0) return json(c, 200, { data: [], meta: { total: 0, page, limit } })
          query = query.where(q => q("id").inList(ids))
        }

        const sortable = new Set(["published_at", "created_at", "updated_at", "title", "slug", "sort_order"])
        const sort = sortable.has(c.query.sort ?? "") ? (c.query.sort as string) : "published_at"
        const order = c.query.order === "asc" ? "ASC" : "DESC"

        const rows = await db.all<EntryRow>(query.orderBy(sort, order).limit(limit).offset(offset))
        const total = await countRows(db, query.select("COUNT(*) as total"))

        const data = await shape(type, rows, included(c.query.include), keyIdentity(c))
        return json(privateCache(c, 30), 200, {
          data,
          meta: { type: type.name, total, page, limit },
        })
      }),
    ),

    get(
      "/content/:type/:slug",
      guard(async c => {
        const type = await loadType(c.params.type ?? "", c)

        // A `single` type has one entry and no meaningful slug, so /single is
        // the conventional way to ask for it.
        const query =
          type.kind === "single" && (c.params.slug === "single" || c.params.slug === "_")
            ? publishedQuery(type.id)
            : publishedQuery(type.id).where(q => q("slug").equals(c.params.slug ?? ""))

        const row = await db.one<EntryRow>(query)
        if (!row) throw notFound("Entry not found")

        const [data] = await shape(type, [row], included(c.query.include), keyIdentity(c))
        return json(privateCache(c, 30), 200, { data })
      }),
    ),

    get(
      "/site/settings",
      guard(async c => {
        const values = await siteSettings(db)

        // Settings that hold a media id are published alongside a resolved
        // `<key>Url`, so a site can render the logo without knowing that media
        // ids exist or making a second request. The id stays for callers that
        // want it.
        const mediaKeys = ["logoId", "faviconId", "socialImageId"] as const
        const ids = mediaKeys.map(key => values[key]).filter((v): v is string => typeof v === "string" && v !== "")

        const rows =
          ids.length === 0
            ? []
            : await db.all<MediaRow>(
                from(media)
                  .where(q => q("id").inList(ids))
                  .where(q => q("deleted_at").isNull()),
              )
        const byId = new Map(rows.map(row => [row.id, row]))

        const resolved: Record<string, unknown> = { ...values }
        for (const key of mediaKeys) {
          const found = typeof values[key] === "string" ? byId.get(values[key] as string) : undefined
          resolved[key.replace(/Id$/, "Url")] = found ? publicUrl(found.url) : ""
        }

        return json(privateCache(c, 60), 200, { data: resolved })
      }),
    ),

    get(
      "/site/menus/:name",
      guard(async c => {
        const row = await db.one<{ name: string; label: string; items: string }>(
          from(menus)
            .select("name", "label", "items")
            .where(q => q("name").equals(c.params.name ?? "")),
        )
        if (!row) throw notFound("Menu not found")
        return json(privateCache(c, 60), 200, {
          data: { name: row.name, label: row.label, items: decodeArray(row.items) },
        })
      }),
    ),

    // Lets a consuming site discover what it is allowed to read and what shape
    // each type has, which is what makes a generic renderer possible.
    get(
      "/content",
      guard(async c => {
        const identity = keyIdentity(c)
        const rows = await db.all<ContentTypeRow>(from("content_types").orderBy("sort_order", "ASC"))
        return json(c, 200, {
          data: rows
            .filter(row => keyAllows(identity, row.name))
            .map(row => ({
              name: row.name,
              label: row.label,
              pluralLabel: row.plural_label,
              kind: row.kind,
              fields: decodeArray<Field>(row.fields).map(f => ({ key: f.key, type: f.type, label: f.label })),
            })),
        })
      }),
    ),
  ]
}
