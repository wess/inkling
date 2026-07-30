import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn, Route } from "@atlas/server"
import {
  badRequest,
  conflict,
  del,
  forbidden,
  get,
  isHttpError,
  json,
  notFound,
  parseJson,
  pipeline,
  post,
  put,
} from "@atlas/server"
import type { Identity } from "../auth/guard.ts"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import type { ContentTypeRow } from "../contenttypes/index.ts"
import { byId as typeById, byName as typeByName } from "../contenttypes/index.ts"
import { contains, countRows, embeds, paging, rows } from "../db/dialect.ts"
import type { Field } from "../fields/index.ts"
import { blank, validate } from "../fields/index.ts"
import { body, either, optionalText } from "../http/index.ts"
import { id, slugify } from "../ids/index.ts"
import { decodeArray, decodeObject, encode } from "../json/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { contentTypes, entries, media as mediaTable, revisions, users } from "../schema/index.ts"
import { now, parseIso } from "../time/index.ts"

export const STATUSES = ["draft", "review", "scheduled", "published", "archived"] as const
export type Status = (typeof STATUSES)[number]

export type EntryRow = {
  id: string
  content_type_id: string
  slug: string
  title: string
  data: string
  status: string
  locale: string
  author_id: string | null
  sort_order: number
  published_at: string | null
  scheduled_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export const present = (row: EntryRow, typeName?: string) => ({
  id: row.id,
  type: typeName,
  contentTypeId: row.content_type_id,
  slug: row.slug,
  title: row.title,
  data: decodeObject(row.data),
  status: row.status,
  locale: row.locale,
  authorId: row.author_id,
  sortOrder: row.sort_order,
  publishedAt: row.published_at,
  scheduledAt: row.scheduled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
})

// Slug uniqueness is scoped to (type, locale) and ignores soft-deleted rows so
// restoring from trash never collides with something created since. Enforced
// here rather than by a unique index because partial indexes are not portable.
const slugTaken = async (
  db: Connection,
  typeId: string,
  locale: string,
  slug: string,
  exceptId?: string,
): Promise<boolean> => {
  const base = from(entries)
    .select("id")
    .where(q => q("content_type_id").equals(typeId))
    .where(q => q("locale").equals(locale))
    .where(q => q("slug").equals(slug))
    .where(q => q("deleted_at").isNull())
  const scoped = exceptId ? base.where(q => q("id").notEquals(exceptId)) : base
  return (await db.one(scoped)) !== null
}

const uniqueSlug = async (
  db: Connection,
  typeId: string,
  locale: string,
  desired: string,
  exceptId?: string,
): Promise<string> => {
  const base = slugify(desired)
  let candidate = base
  let suffix = 2
  while (await slugTaken(db, typeId, locale, candidate, exceptId)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

const snapshot = async (db: Connection, entry: EntryRow, authorId: string | null, note: string | null) => {
  await db.execute(
    from(revisions).insert({
      id: id(),
      entry_id: entry.id,
      title: entry.title,
      data: entry.data,
      status: entry.status,
      author_id: authorId,
      note,
      created_at: now(),
    }),
  )
}

// An author may only touch their own entries; editor and above may touch any.
const assertMayEdit = (identity: Identity, row: EntryRow): void => {
  if (can.publishContent(identity.role)) return
  if (row.author_id !== identity.id) throw forbidden("You can only change entries you authored", { code: "NOT_YOURS" })
}

// Who the entry is credited to. Absent an explicit `authorId` the existing
// credit stands, so an editor fixing a typo does not take over the byline.
const resolveAuthor = async (
  db: Connection,
  identity: Identity,
  input: Record<string, unknown>,
  existing: EntryRow,
): Promise<string | null> => {
  if (input.authorId === undefined) return existing.author_id

  if (!can.publishContent(identity.role)) {
    throw forbidden("Only an editor can change who an entry is credited to", { code: "NOT_YOURS" })
  }

  const authorId = optionalText(input, "authorId")
  if (!authorId) return null

  const user = await db.one<{ id: string }>(
    from(users)
      .where(q => q("id").equals(authorId))
      .where(q => q("deleted_at").isNull()),
  )
  if (!user) throw badRequest("That author is not a known user", { code: "BAD_AUTHOR" })
  return user.id
}

const validateAgainstType = (type: ContentTypeRow, input: unknown, existing: Record<string, unknown>) => {
  const fields = decodeArray<Field>(type.fields)
  const supplied = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  // Merge over what is stored so a partial save from the editor doesn't blank
  // fields it never rendered.
  const merged = { ...blank(fields), ...existing, ...supplied }
  const result = validate(fields, merged)
  if (!result.valid) {
    throw badRequest("Some fields need attention", {
      code: "VALIDATION_FAILED",
      details: { fields: result.errors },
    })
  }
  return result.data
}

const validateRelations = async (
  db: Connection,
  type: ContentTypeRow,
  data: Record<string, unknown>,
): Promise<void> => {
  const mediaIds: { key: string; id: string }[] = []
  const references: { key: string; id: string; type: string }[] = []

  const collect = (fields: readonly Field[], values: Record<string, unknown>, root?: string) => {
    for (const field of fields) {
      const key = root ?? field.key
      const value = values[field.key]
      if (field.type === "media" && typeof value === "string") mediaIds.push({ key, id: value })
      if (field.type === "gallery" && Array.isArray(value)) {
        for (const mediaId of value) if (typeof mediaId === "string") mediaIds.push({ key, id: mediaId })
      }
      if (field.type === "reference" && field.of) {
        const ids = Array.isArray(value) ? value : [value]
        for (const entryId of ids) {
          if (typeof entryId === "string") references.push({ key, id: entryId, type: field.of })
        }
      }
      if (field.type === "list" && field.fields && Array.isArray(value)) {
        for (const row of value) {
          if (typeof row === "object" && row !== null) collect(field.fields, row as Record<string, unknown>, key)
        }
      }
    }
  }
  collect(decodeArray<Field>(type.fields), data)

  const errors: { key: string; message: string }[] = []
  const requestedMedia = [...new Set(mediaIds.map(item => item.id))]
  if (requestedMedia.length > 0) {
    const found = await db.all<{ id: string }>(
      from(mediaTable)
        .select("id")
        .where(q => q("id").inList(requestedMedia))
        .where(q => q("deleted_at").isNull()),
    )
    const available = new Set(found.map(item => item.id))
    for (const item of mediaIds) {
      if (!available.has(item.id)) errors.push({ key: item.key, message: "points to media that is unavailable" })
    }
  }

  const requestedEntries = [...new Set(references.map(item => item.id))]
  if (requestedEntries.length > 0) {
    const found = await db.all<{ id: string; content_type_id: string }>(
      from(entries)
        .select("id", "content_type_id")
        .where(q => q("id").inList(requestedEntries))
        .where(q => q("deleted_at").isNull()),
    )
    const available = new Map(found.map(item => [item.id, item.content_type_id]))
    const targetTypes = new Map<string, string>()
    for (const name of new Set(references.map(item => item.type))) {
      const target = await typeByName(db, name)
      if (target) targetTypes.set(name, target.id)
    }
    for (const item of references) {
      const targetId = targetTypes.get(item.type)
      if (!targetId || available.get(item.id) !== targetId) {
        errors.push({ key: item.key, message: `must point to an existing ${item.type} entry` })
      }
    }
  }

  if (errors.length > 0) {
    const unique = [...new Map(errors.map(error => [`${error.key}:${error.message}`, error])).values()]
    throw badRequest("Some fields point to content that is unavailable", {
      code: "VALIDATION_FAILED",
      details: { fields: unique },
    })
  }
}

const includesReference = (fields: readonly Field[], data: Record<string, unknown>, entryId: string): boolean => {
  for (const field of fields) {
    const value = data[field.key]
    if (field.type === "reference" && (value === entryId || (Array.isArray(value) && value.includes(entryId)))) {
      return true
    }
    if (field.type === "list" && field.fields && Array.isArray(value)) {
      for (const item of value) {
        if (
          typeof item === "object" &&
          item !== null &&
          includesReference(field.fields, item as Record<string, unknown>, entryId)
        ) {
          return true
        }
      }
    }
  }
  return false
}

// Does this field set declare a reference to `target` anywhere, including inside
// a nested list? A type that doesn't cannot possibly point at an entry of that
// type, so it never has to be read.
const declaresReferenceTo = (fields: readonly Field[], target: string): boolean =>
  fields.some(
    field =>
      (field.type === "reference" && field.of === target) ||
      (field.type === "list" && field.fields !== undefined && declaresReferenceTo(field.fields, target)),
  )

// Finding what points at an entry means looking inside a JSON `data` blob, which
// neither dialect can query portably. Rather than parse every row, the candidate
// set is narrowed twice in SQL first: to types that actually declare a reference
// to this entry's type, and to rows whose `data` literally contains the id. Only
// those survivors are parsed, which is what confirms the id is in a reference
// field rather than incidentally present in some text.
const entryUsage = async (
  db: Connection,
  entry: { id: string; content_type_id: string },
  includeDeleted: boolean,
): Promise<{ id: string; title: string }[]> => {
  const ownType = await typeById(db, entry.content_type_id)
  if (!ownType) return []

  const types = await db.all<{ id: string; fields: string }>(from(contentTypes).select("id", "fields"))
  const fieldsByType = new Map(types.map(type => [type.id, decodeArray<Field>(type.fields)]))
  const candidateTypes = types
    .filter(type => declaresReferenceTo(fieldsByType.get(type.id) ?? [], ownType.name))
    .map(type => type.id)
  if (candidateTypes.length === 0) return []

  const base = from(entries)
    .select("id", "title", "content_type_id", "data")
    .where(q => q("id").notEquals(entry.id))
    .where(q => q("content_type_id").inList(candidateTypes))
    .where(q => q.raw(embeds("data", entry.id)))
  const candidates = await db.all<{ id: string; title: string; content_type_id: string; data: string }>(
    includeDeleted ? base : base.where(q => q("deleted_at").isNull()),
  )
  return candidates
    .filter(row => includesReference(fieldsByType.get(row.content_type_id) ?? [], decodeObject(row.data), entry.id))
    .map(row => ({ id: row.id, title: row.title }))
}

const assertEntryUnused = async (
  db: Connection,
  entry: { id: string; content_type_id: string },
  includeDeleted: boolean,
): Promise<void> => {
  const usage = await entryUsage(db, entry, includeDeleted)
  if (usage.length === 0) return
  throw conflict(
    `This entry is referenced by ${usage.length} other ${usage.length === 1 ? "entry" : "entries"}. Remove those links first.`,
    {
      code: "IN_USE",
      details: { entryCount: usage.length, entries: usage.slice(0, 10) },
    },
  )
}

const parseLocale = (value: string | null, fallback: string): string => {
  const locale = value ?? fallback
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
    throw badRequest("Locale must be a language code such as en or en-US", { code: "BAD_LOCALE" })
  }
  return locale
}

// Publishing one entry. Extracted so the single-entry route and the bulk route
// share it rather than each carrying their own copy of the revalidation, the
// snapshot, and the hook order — a second implementation of this is exactly how
// "bulk publish skipped validation" becomes a bug.
const publishOne = async (
  db: Connection,
  hooks: Hooks,
  existing: EntryRow,
  type: ContentTypeRow,
  identity: Identity,
  scheduledAt: string | null,
): Promise<EntryRow> => {
  const timestamp = now()
  const status: Status = scheduledAt && scheduledAt > timestamp ? "scheduled" : "published"

  // Republishing is a no-op rather than an error — the button in the UI
  // shouldn't fail just because someone else got there first.
  if (existing.status === "published" && status === "published") return existing

  // A type may have gained required fields while this entry was a draft.
  // Refuse to publish data that no longer satisfies the current schema.
  const data = validateAgainstType(type, decodeObject(existing.data), {})
  await validateRelations(db, type, data)

  await hooks.emit("entry.beforePublish", { entry: existing, type, identity })

  const next = {
    status,
    published_at: status === "published" ? (existing.published_at ?? timestamp) : null,
    scheduled_at: status === "scheduled" ? scheduledAt : null,
    updated_at: timestamp,
  }

  await db.transaction(async tx => {
    await snapshot(tx, existing, identity.id, status === "scheduled" ? "Before scheduling" : "Before publish")
    await tx.execute(
      from(entries)
        .update(next)
        .where(q => q("id").equals(existing.id)),
    )
  })

  const updated = { ...existing, ...next } as EntryRow
  await hooks.emit("entry.afterPublish", { entry: updated, type, identity })
  return updated
}

// The editorial statuses, plus unpublish. Shares the same reasoning as
// publishOne: one place that knows a transition snapshots first and tells the
// hook bus afterwards.
const transitionOne = async (
  db: Connection,
  hooks: Hooks,
  existing: EntryRow,
  identity: Identity,
  status: "draft" | "review" | "archived",
  note: string,
): Promise<EntryRow> => {
  const next = { status, published_at: null, scheduled_at: null, updated_at: now() }

  await db.transaction(async tx => {
    await snapshot(tx, existing, identity.id, note)
    await tx.execute(
      from(entries)
        .update(next)
        .where(q => q("id").equals(existing.id)),
    )
  })

  const updated = { ...existing, ...next } as EntryRow
  // Going off-air is the event a consumer cares about, so it is announced only
  // when the entry was actually live.
  if (existing.status === "published" || existing.status === "scheduled") {
    await hooks.emit("entry.afterUnpublish", {
      entry: updated,
      type: await typeById(db, existing.content_type_id),
      identity,
    })
  }
  return updated
}

export const entryRoutes = (db: Connection, hooks: Hooks): Route[] => {
  const read = pipeline(requireAuth(db))
  const write = pipeline(requireAuth(db), requireCan(can.writeContent, "edit content"), parseJson)
  const act = pipeline(requireAuth(db), requireCan(can.writeContent, "edit content"))
  const trashRead = pipeline(requireAuth(db), requireCan(can.writeContent, "view deleted content"))

  const loadType = async (c: Conn): Promise<ContentTypeRow> => {
    const name = c.params.type ?? ""
    const type = await typeByName(db, name)
    if (!type) throw notFound(`Content type "${name}" not found`)
    return type
  }

  const loadEntry = async (entryId: string): Promise<EntryRow> => {
    const row = await db.one<EntryRow>(
      from(entries)
        .where(q => q("id").equals(entryId))
        .where(q => q("deleted_at").isNull()),
    )
    if (!row) throw notFound("Entry not found")
    return row
  }

  return [
    get(
      "/types/:type/entries",
      read(async c => {
        const type = await loadType(c)
        const { limit, offset, page } = paging(c.query)

        // String-table form so the same filter chain can be reused for the
        // COUNT(*) — see the note in src/db/dialect.ts.
        let query = from("entries")
          .where(q => q("content_type_id").equals(type.id))
          .where(q => q("deleted_at").isNull())

        const status = c.query.status
        if (status && status !== "all") query = query.where(q => q("status").equals(status))
        if (c.query.locale) query = query.where(q => q("locale").equals(c.query.locale as string))
        if (c.query.author) query = query.where(q => q("author_id").equals(c.query.author as string))
        if (c.query.q) query = query.where(q => q.raw(contains(db, "title", c.query.q as string)))

        const sortable = new Set(["updated_at", "created_at", "published_at", "title", "slug", "sort_order"])
        const sort = sortable.has(c.query.sort ?? "") ? (c.query.sort as string) : "updated_at"
        const order = c.query.order === "asc" ? "ASC" : "DESC"

        const rows = await db.all<EntryRow>(query.orderBy(sort, order).limit(limit).offset(offset))

        return json(c, 200, {
          data: rows.map(row => present(row, type.name)),
          meta: { total: await countRows(db, query.select("COUNT(*) as total")), page, limit },
        })
      }),
    ),

    get(
      "/entries/:id",
      read(async c => {
        const row = await loadEntry(c.params.id ?? "")
        const type = await typeById(db, row.content_type_id)
        return json(c, 200, present(row, type?.name))
      }),
    ),

    post(
      "/types/:type/entries",
      write(async c => {
        const type = await loadType(c)
        const identity = auth(c)
        const input = body(c)

        // A `single` type holds exactly one entry — the homepage, site hours.
        if (type.kind === "single") {
          const existing = await db.one<{ id: string }>(
            from(entries)
              .select("id")
              .where(q => q("content_type_id").equals(type.id))
              .where(q => q("deleted_at").isNull()),
          )
          if (existing) {
            throw conflict(`"${type.label}" is a single-entry type and already has its entry`, {
              code: "SINGLE_EXISTS",
              details: { entryId: existing.id },
            })
          }
        }

        const title = optionalText(input, "title") ?? "Untitled"
        const locale = parseLocale(optionalText(input, "locale"), "en")
        const slug = await uniqueSlug(db, type.id, locale, optionalText(input, "slug") ?? title)
        const data = validateAgainstType(type, either(input, "data", "data"), {})
        await validateRelations(db, type, data)

        const timestamp = now()
        const row: EntryRow = {
          id: id(),
          content_type_id: type.id,
          slug,
          title,
          data: encode(data),
          status: "draft",
          locale,
          author_id: identity.id,
          sort_order: Number(input.sortOrder ?? 0) || 0,
          published_at: null,
          scheduled_at: null,
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
        }

        const shaped = await hooks.filter("entry.beforeSave", { entry: row, type, identity })
        await db.transaction(async tx => {
          await tx.execute(from(entries).insert(shaped.entry))
          await snapshot(tx, shaped.entry, identity.id, "Created")
        })
        await hooks.emit("entry.afterSave", { entry: shaped.entry, type, identity, created: true })

        return json(c, 201, present(shaped.entry, type.name))
      }),
    ),

    put(
      "/entries/:id",
      write(async c => {
        const existing = await loadEntry(c.params.id ?? "")
        const identity = auth(c)
        assertMayEdit(identity, existing)

        const type = await typeById(db, existing.content_type_id)
        if (!type) throw notFound("Content type not found")

        const input = body(c)
        const title = input.title === undefined ? existing.title : (optionalText(input, "title") ?? existing.title)
        const locale = parseLocale(optionalText(input, "locale"), existing.locale)

        const desiredSlug = optionalText(input, "slug")
        const slug =
          desiredSlug && slugify(desiredSlug) !== existing.slug
            ? await uniqueSlug(db, type.id, locale, desiredSlug, existing.id)
            : existing.slug

        const data =
          input.data === undefined
            ? decodeObject(existing.data)
            : validateAgainstType(type, input.data, decodeObject(existing.data))
        await validateRelations(db, type, data)

        // Reassigning the byline is an editorial act, not an authoring one — an
        // author could otherwise pin their draft on someone else. Importers and
        // editors writing up a colleague's piece both need it.
        const authorId = await resolveAuthor(db, identity, input, existing)

        const next: EntryRow = {
          ...existing,
          title,
          slug,
          locale,
          data: encode(data),
          author_id: authorId,
          sort_order: input.sortOrder === undefined ? existing.sort_order : Number(input.sortOrder) || 0,
          updated_at: now(),
        }

        const shaped = await hooks.filter("entry.beforeSave", { entry: next, type, identity })

        // Snapshot the pre-edit state, so a revision restores what it replaced.
        await db.transaction(async tx => {
          await snapshot(tx, existing, identity.id, optionalText(input, "note"))
          await tx.execute(
            from(entries)
              .update({
                title: shaped.entry.title,
                slug: shaped.entry.slug,
                locale: shaped.entry.locale,
                data: shaped.entry.data,
                author_id: shaped.entry.author_id,
                sort_order: shaped.entry.sort_order,
                updated_at: shaped.entry.updated_at,
              })
              .where(q => q("id").equals(existing.id)),
          )
        })
        await hooks.emit("entry.afterSave", { entry: shaped.entry, type, identity, created: false })

        return json(c, 200, present(shaped.entry, type.name))
      }),
    ),

    post(
      "/entries/:id/publish",
      act(async c => {
        const existing = await loadEntry(c.params.id ?? "")
        const identity = auth(c)
        if (!can.publishContent(identity.role)) {
          throw forbidden("Publishing needs the editor role or higher", { code: "DENIED" })
        }

        const type = await typeById(db, existing.content_type_id)
        if (!type) throw notFound("Content type not found")

        // Republishing is a no-op rather than an error — the button in the UI
        // shouldn't fail just because someone else got there first.
        const requestedAt = c.query.at
        const scheduledAt = parseIso(requestedAt)
        if (requestedAt && !scheduledAt) {
          throw badRequest("The scheduled publishing time is invalid", { code: "BAD_SCHEDULE" })
        }

        const updated = await publishOne(db, hooks, existing, type, identity, scheduledAt)
        return json(c, 200, present(updated, type.name))
      }),
    ),

    post(
      "/entries/:id/unpublish",
      act(async c => {
        const existing = await loadEntry(c.params.id ?? "")
        const identity = auth(c)
        if (!can.publishContent(identity.role)) {
          throw forbidden("Unpublishing needs the editor role or higher", { code: "DENIED" })
        }

        const type = await typeById(db, existing.content_type_id)
        if (existing.status === "draft") return json(c, 200, present(existing, type?.name))

        const updated = await transitionOne(db, hooks, existing, identity, "draft", "Before unpublish")
        return json(c, 200, present(updated, type?.name))
      }),
    ),

    post(
      "/entries/:id/status",
      write(async c => {
        const existing = await loadEntry(c.params.id ?? "")
        const identity = auth(c)
        assertMayEdit(identity, existing)

        const status = String(body(c).status ?? "")
        const editorialStatuses = ["draft", "review", "archived"] as const
        if (!(editorialStatuses as readonly string[]).includes(status)) {
          throw badRequest(
            `Status must be one of: ${editorialStatuses.join(", ")}; use the publish action to go live`,
            {
              code: "BAD_STATUS",
            },
          )
        }

        const updated = await transitionOne(
          db,
          hooks,
          existing,
          identity,
          status as "draft" | "review" | "archived",
          `Before ${status}`,
        )
        return json(c, 200, present(updated))
      }),
    ),

    // Copying an entry is how most editorial work actually starts — a new issue
    // of a recurring page, a variant of a product. The copy is always a draft
    // credited to whoever made it, never inheriting published state.
    post(
      "/entries/:id/duplicate",
      act(async c => {
        const source = await loadEntry(c.params.id ?? "")
        const identity = auth(c)
        const type = await typeById(db, source.content_type_id)
        if (!type) throw notFound("Content type not found")

        // A single-entry type already has its one entry by definition.
        if (type.kind === "single") {
          throw conflict(`"${type.label}" is a single-entry type and cannot be duplicated`, { code: "SINGLE_EXISTS" })
        }

        const title = `${source.title} (copy)`
        const slug = await uniqueSlug(db, type.id, source.locale, `${source.slug}-copy`)
        const timestamp = now()

        // Data is copied verbatim rather than revalidated. A draft is allowed to
        // be incomplete, and publish revalidates against the current schema — so
        // re-checking here would refuse to copy an entry the editor can already
        // see and wants to work from.
        const row: EntryRow = {
          ...source,
          id: id(),
          slug,
          title,
          status: "draft",
          author_id: identity.id,
          published_at: null,
          scheduled_at: null,
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
        }

        await db.transaction(async tx => {
          await tx.execute(from(entries).insert(row))
          await snapshot(tx, row, identity.id, `Duplicated from ${source.slug}`)
        })
        await hooks.emit("entry.afterSave", { entry: row, type, identity, created: true })

        return json(c, 201, present(row, type.name))
      }),
    ),

    // One request for an action an editor is applying to a selection. Results are
    // per-entry rather than all-or-nothing: a partial failure is the normal case
    // (one entry in the selection fails validation, the rest publish), and
    // rolling back the successes to punish it would be the wrong answer.
    post(
      "/entries/bulk",
      write(async c => {
        const input = body(c)
        const identity = auth(c)

        const raw = input.ids
        if (!Array.isArray(raw) || raw.some(value => typeof value !== "string") || raw.length === 0) {
          throw badRequest("`ids` must be a non-empty array of entry ids", { code: "BAD_IDS" })
        }
        // Bounded before deduping, so an absurd body is refused on its face
        // rather than after being collapsed into something small.
        if (raw.length > 200) throw badRequest("At most 200 entries at a time", { code: "TOO_MANY" })
        const ids = [...new Set(raw as string[])]

        const actions = ["publish", "unpublish", "draft", "review", "archive", "delete"] as const
        const action = String(input.action ?? "")
        if (!(actions as readonly string[]).includes(action)) {
          throw badRequest(`\`action\` must be one of: ${actions.join(", ")}`, { code: "BAD_ACTION" })
        }

        const requestedAt = optionalText(input, "at")
        const scheduledAt = parseIso(requestedAt)
        if (requestedAt && !scheduledAt) {
          throw badRequest("The scheduled publishing time is invalid", { code: "BAD_SCHEDULE" })
        }

        const results: { id: string; ok: boolean; status?: string; error?: string; code?: string }[] = []

        for (const entryId of ids) {
          try {
            const existing = await db.one<EntryRow>(
              from(entries)
                .where(q => q("id").equals(entryId))
                .where(q => q("deleted_at").isNull()),
            )
            if (!existing) {
              results.push({ id: entryId, ok: false, error: "Entry not found", code: "NOT_FOUND" })
              continue
            }

            // Every per-entry rule the single-entry routes apply is applied here
            // too. Bulk is a convenience over the same permissions, not a way
            // around them.
            if (action === "publish" || action === "unpublish") {
              if (!can.publishContent(identity.role)) {
                throw forbidden("Publishing needs the editor role or higher", { code: "DENIED" })
              }
            } else {
              assertMayEdit(identity, existing)
            }

            if (action === "publish") {
              const type = await typeById(db, existing.content_type_id)
              if (!type) throw notFound("Content type not found")
              const updated = await publishOne(db, hooks, existing, type, identity, scheduledAt)
              results.push({ id: entryId, ok: true, status: updated.status })
              continue
            }

            if (action === "delete") {
              await assertEntryUnused(db, existing, false)
              await db.execute(
                from(entries)
                  .update({ deleted_at: now(), updated_at: now() })
                  .where(q => q("id").equals(existing.id)),
              )
              await hooks.emit("entry.afterDelete", { entry: existing, identity })
              results.push({ id: entryId, ok: true, status: "deleted" })
              continue
            }

            const target = action === "unpublish" ? "draft" : action === "archive" ? "archived" : action
            const updated = await transitionOne(
              db,
              hooks,
              existing,
              identity,
              target as "draft" | "review" | "archived",
              `Before ${target} (bulk)`,
            )
            results.push({ id: entryId, ok: true, status: updated.status })
          } catch (error) {
            // Anything thrown here is one entry's problem. The HttpError carries
            // the message the single-entry route would have returned, so the UI
            // can show the same text next to the row that failed.
            const message = isHttpError(error) ? error.message : "Could not be updated"
            const code = isHttpError(error) ? error.code : undefined
            results.push({ id: entryId, ok: false, error: message, code })
          }
        }

        const changed = results.filter(result => result.ok).length
        return json(c, 200, {
          data: results,
          meta: { action, requested: ids.length, changed, failed: ids.length - changed },
        })
      }),
    ),

    // Soft delete — the row keeps its slug so a restore is lossless.
    del(
      "/entries/:id",
      act(async c => {
        const existing = await loadEntry(c.params.id ?? "")
        const identity = auth(c)
        assertMayEdit(identity, existing)
        await assertEntryUnused(db, existing, false)

        await db.execute(
          from(entries)
            .update({ deleted_at: now(), updated_at: now() })
            .where(q => q("id").equals(existing.id)),
        )
        await hooks.emit("entry.afterDelete", { entry: existing, identity })

        return json(c, 200, { deleted: true, id: existing.id })
      }),
    ),

    get(
      "/trash/entries",
      trashRead(async c => {
        const { limit, offset } = paging(c.query)
        const identity = auth(c)
        const deleted = from(entries).where(q => q("deleted_at").isNotNull())
        const visible = can.publishContent(identity.role)
          ? deleted
          : deleted.where(q => q("author_id").equals(identity.id))
        const rows = await db.all<EntryRow>(visible.orderBy("deleted_at", "DESC").limit(limit).offset(offset))
        return json(c, 200, { data: rows.map(row => present(row)) })
      }),
    ),

    post(
      "/trash/entries/:id/restore",
      act(async c => {
        const row = await db.one<EntryRow>(
          from(entries)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNotNull()),
        )
        if (!row) throw notFound("Entry not found in trash")
        const identity = auth(c)
        assertMayEdit(identity, row)

        // Something may have claimed the slug while this sat in the trash.
        const slug = await uniqueSlug(db, row.content_type_id, row.locale, row.slug, row.id)
        const next = {
          deleted_at: null,
          slug,
          status: "draft" as const,
          published_at: null,
          scheduled_at: null,
          updated_at: now(),
        }
        await db.execute(
          from(entries)
            .update(next)
            .where(q => q("id").equals(row.id)),
        )
        const restored = { ...row, ...next }
        const type = await typeById(db, row.content_type_id)
        await hooks.emit("entry.afterSave", { entry: restored, type, identity, created: false })
        return json(c, 200, present(restored, type?.name))
      }),
    ),

    del(
      "/trash/entries/:id",
      pipeline(
        requireAuth(db),
        requireCan(can.deleteAnyContent, "permanently delete content"),
      )(async c => {
        const row = await db.one<EntryRow>(
          from(entries)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNotNull()),
        )
        if (!row) throw notFound("Entry not found in trash")
        await assertEntryUnused(db, row, true)

        // Revisions reference the entry, so they go first to avoid an FK error
        // on Postgres (SQLite would allow it only with foreign_keys off).
        await db.transaction(async tx => {
          await tx.execute(
            from(revisions)
              .where(q => q("entry_id").equals(row.id))
              .del(),
          )
          await tx.execute(
            from(entries)
              .where(q => q("id").equals(row.id))
              .del(),
          )
        })
        return json(c, 200, { purged: true, id: row.id })
      }),
    ),

    get(
      "/entries/:id/revisions",
      read(async c => {
        const entry = await loadEntry(c.params.id ?? "")
        const history = await rows<{
          id: string
          title: string
          status: string
          author_id: string | null
          note: string | null
          created_at: string
          author_name: string | null
        }>(
          db,
          from("revisions", "r")
            .leftJoin("users", "u.id = r.author_id", "u")
            .select("r.id", "r.title", "r.status", "r.author_id", "r.note", "r.created_at", "u.name as author_name")
            .where(q => q("r.entry_id").equals(entry.id))
            .orderBy("r.created_at", "DESC")
            .limit(100),
        )

        return json(c, 200, {
          data: history.map(row => ({
            id: row.id,
            title: row.title,
            status: row.status,
            authorId: row.author_id,
            authorName: row.author_name,
            note: row.note,
            createdAt: row.created_at,
          })),
        })
      }),
    ),

    get(
      "/revisions/:id",
      read(async c => {
        const row = await db.one<{
          id: string
          entry_id: string
          title: string
          data: string
          status: string
          created_at: string
        }>(from(revisions).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Revision not found")
        return json(c, 200, {
          id: row.id,
          entryId: row.entry_id,
          title: row.title,
          data: decodeObject(row.data),
          status: row.status,
          createdAt: row.created_at,
        })
      }),
    ),

    post(
      "/revisions/:id/restore",
      act(async c => {
        const revision = await db.one<{ id: string; entry_id: string; title: string; data: string }>(
          from(revisions).where(q => q("id").equals(c.params.id ?? "")),
        )
        if (!revision) throw notFound("Revision not found")

        const entry = await loadEntry(revision.entry_id)
        const identity = auth(c)
        assertMayEdit(identity, entry)
        const type = await typeById(db, entry.content_type_id)
        if (!type) throw notFound("Content type not found")
        const data = validateAgainstType(type, decodeObject(revision.data), {})
        await validateRelations(db, type, data)
        const updated = { ...entry, title: revision.title, data: encode(data), updated_at: now() }

        // Restoring is itself an edit: snapshot current state first so the
        // restore can be undone.
        await db.transaction(async tx => {
          await snapshot(tx, entry, identity.id, "Before restore")
          await tx.execute(
            from(entries)
              .update({ title: updated.title, data: updated.data, updated_at: updated.updated_at })
              .where(q => q("id").equals(entry.id)),
          )
        })
        await hooks.emit("entry.afterSave", { entry: updated, type, identity, created: false })

        return json(c, 200, present(updated, type.name))
      }),
    ),
  ]
}

// Promotes entries whose scheduled time has arrived. Called on an interval from
// src/server.ts rather than depending on an external cron.
const runPublishDue = async (db: Connection, hooks: Hooks): Promise<number> => {
  const due = await db.all<EntryRow>(
    from(entries)
      .where(q => q("status").equals("scheduled"))
      .where(q => q("scheduled_at").isNotNull())
      .where(q => q("scheduled_at").lessThanOrEqual(now()))
      .where(q => q("deleted_at").isNull())
      .limit(100),
  )

  let published = 0
  for (const entry of due) {
    const type = await typeById(db, entry.content_type_id)
    if (!type) continue
    try {
      const data = validateAgainstType(type, decodeObject(entry.data), {})
      await validateRelations(db, type, data)
    } catch (error) {
      if (!isHttpError(error) || error.status !== 400) throw error
      const blocked = {
        status: "review" as const,
        scheduled_at: null,
        updated_at: now(),
      }
      let changed = false
      await db.transaction(async tx => {
        const claimed = await tx.execute(
          from(entries)
            .update(blocked)
            .where(q => q("id").equals(entry.id))
            .where(q => q("status").equals("scheduled"))
            .returning("id"),
        )
        if (claimed.length === 0) return
        await snapshot(tx, entry, null, "Scheduled publish blocked by validation")
        changed = true
      })
      if (changed) {
        await hooks.emit("entry.afterSave", {
          entry: { ...entry, ...blocked },
          type,
          identity: null,
          created: false,
        })
      }
      continue
    }

    const timestamp = now()
    const next = {
      status: "published" as const,
      published_at: entry.scheduled_at ?? timestamp,
      scheduled_at: null,
      updated_at: timestamp,
    }
    let changed = false
    await db.transaction(async tx => {
      const claimed = await tx.execute(
        from(entries)
          .update(next)
          .where(q => q("id").equals(entry.id))
          .where(q => q("status").equals("scheduled"))
          .returning("id"),
      )
      if (claimed.length === 0) return
      await snapshot(tx, entry, null, "Before scheduled publish")
      changed = true
    })
    if (!changed) continue

    const updated = { ...entry, ...next } as EntryRow
    await hooks.emit("entry.afterPublish", { entry: updated, type, identity: null })
    published += 1
  }

  return published
}

// Atlas's SQLite driver owns one connection and cannot begin a second
// transaction while the first is open. Collapse overlapping timer ticks on a
// connection; the conditional row claim inside runPublishDue still protects
// separate processes and Postgres connections from duplicate notifications.
const activeSweeps = new WeakMap<object, Promise<number>>()

export const publishDue = (db: Connection, hooks: Hooks): Promise<number> => {
  const key = db as object
  const active = activeSweeps.get(key)
  if (active) return active.then(() => 0)

  const sweep = runPublishDue(db, hooks)
  activeSweeps.set(key, sweep)
  void sweep.then(
    () => activeSweeps.delete(key),
    () => activeSweeps.delete(key),
  )
  return sweep
}
