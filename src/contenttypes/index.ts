import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Route } from "@atlas/server"
import { badRequest, conflict, del, get, json, notFound, parseJson, pipeline, post, put } from "@atlas/server"
import { requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { countRows } from "../db/dialect.ts"
import type { Field } from "../fields/index.ts"
import { validateDefinition } from "../fields/index.ts"
import { body, optionalText, requireText } from "../http/index.ts"
import { id, isHandle, slugify } from "../ids/index.ts"
import { decodeArray, encode } from "../json/index.ts"
import { contentTypes } from "../schema/index.ts"
import { now } from "../time/index.ts"

export type ContentTypeRow = {
  id: string
  name: string
  label: string
  plural_label: string
  description: string | null
  kind: string
  preview_url: string | null
  fields: string
  icon: string | null
  sort_order: number
  owner_plugin: string | null
  created_at: string
  updated_at: string
}

export type ContentType = {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly pluralLabel: string
  readonly description: string | null
  readonly kind: "collection" | "single"
  readonly previewUrl: string | null
  readonly fields: readonly Field[]
  readonly icon: string | null
  readonly sortOrder: number
  readonly ownerPlugin: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export const present = (row: ContentTypeRow): ContentType => ({
  id: row.id,
  name: row.name,
  label: row.label,
  pluralLabel: row.plural_label,
  description: row.description,
  kind: row.kind === "single" ? "single" : "collection",
  previewUrl: row.preview_url,
  fields: decodeArray<Field>(row.fields),
  icon: row.icon,
  sortOrder: row.sort_order,
  ownerPlugin: row.owner_plugin,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const byName = async (db: Connection, name: string): Promise<ContentTypeRow | null> =>
  db.one<ContentTypeRow>(from(contentTypes).where(q => q("name").equals(name)))

export const byId = async (db: Connection, typeId: string): Promise<ContentTypeRow | null> =>
  db.one<ContentTypeRow>(from(contentTypes).where(q => q("id").equals(typeId)))

// Used by the plugin registry to declare a type on enable. Idempotent: an
// existing type owned by the same plugin is updated in place, one owned by
// someone else is left alone so a plugin can never hijack core content.
export const upsertOwned = async (
  db: Connection,
  ownerPlugin: string,
  definition: {
    name: string
    label: string
    pluralLabel?: string
    description?: string
    kind?: "collection" | "single"
    previewUrl?: string
    fields: readonly Field[]
    icon?: string
    sortOrder?: number
  },
): Promise<{ readonly created: boolean; readonly skipped?: string }> => {
  const existing = await byName(db, definition.name)
  const timestamp = now()

  if (existing) {
    if (existing.owner_plugin !== ownerPlugin) {
      return {
        created: false,
        skipped: `content type "${definition.name}" already exists and is not owned by ${ownerPlugin}`,
      }
    }
    await db.execute(
      from(contentTypes)
        .update({
          label: definition.label,
          plural_label: definition.pluralLabel ?? `${definition.label}s`,
          description: definition.description ?? null,
          kind: definition.kind ?? "collection",
          preview_url: definition.previewUrl ?? null,
          fields: encode(definition.fields),
          icon: definition.icon ?? null,
          updated_at: timestamp,
        })
        .where(q => q("id").equals(existing.id)),
    )
    return { created: false }
  }

  await db.execute(
    from(contentTypes).insert({
      id: id(),
      name: definition.name,
      label: definition.label,
      plural_label: definition.pluralLabel ?? `${definition.label}s`,
      description: definition.description ?? null,
      kind: definition.kind ?? "collection",
      preview_url: definition.previewUrl ?? null,
      fields: encode(definition.fields),
      icon: definition.icon ?? null,
      sort_order: definition.sortOrder ?? 0,
      owner_plugin: ownerPlugin,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  )
  return { created: true }
}

export const contentTypeRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db))
  const write = pipeline(requireAuth(db), requireCan(can.manageTypes, "manage content types"), parseJson)
  const destroy = pipeline(requireAuth(db), requireCan(can.manageTypes, "manage content types"))

  const parseFields = (raw: unknown): readonly Field[] => {
    const check = validateDefinition(raw)
    if (!check.ok) throw badRequest(check.error, { code: "BAD_FIELDS" })
    return raw as readonly Field[]
  }

  const parsePreviewUrl = (raw: unknown): string | null => {
    if (raw === undefined || raw === null || raw === "") return null
    if (typeof raw !== "string") throw badRequest("Preview URL must be text", { code: "BAD_PREVIEW_URL" })
    const value = raw.trim()
    const unknownTokens = [...value.matchAll(/\{([^}]+)\}/g)]
      .map(match => match[1] ?? "")
      .filter(token => !["id", "locale", "slug", "type"].includes(token))
    if (unknownTokens.length > 0) {
      throw badRequest(`Unknown preview URL token: {${unknownTokens[0]}}`, { code: "BAD_PREVIEW_URL" })
    }
    const sample = value
      .replaceAll("{id}", "id")
      .replaceAll("{locale}", "en")
      .replaceAll("{slug}", "entry")
      .replaceAll("{type}", "article")
    if (sample.startsWith("/")) return value
    try {
      const parsed = new URL(sample)
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return value
    } catch {
      // The useful error is below.
    }
    throw badRequest("Preview URL must start with / or use http(s)", { code: "BAD_PREVIEW_URL" })
  }

  const assertReferencesExist = async (fields: readonly Field[], self: string): Promise<void> => {
    for (const field of fields) {
      if (field.type === "reference" && field.of !== self && !(await byName(db, field.of ?? ""))) {
        throw badRequest(`Field "${field.label}" references a content type that does not exist`, {
          code: "BAD_REFERENCE",
          details: { field: field.key, contentType: field.of },
        })
      }
      if (field.type === "list" && field.fields) await assertReferencesExist(field.fields, self)
    }
  }

  const referencingTypes = async (target: string, exceptId: string): Promise<string[]> => {
    const pointsTo = (fields: readonly Field[]): boolean =>
      fields.some(
        field =>
          (field.type === "reference" && field.of === target) ||
          (field.type === "list" && field.fields !== undefined && pointsTo(field.fields)),
      )
    const rows = await db.all<Pick<ContentTypeRow, "id" | "label" | "fields">>(
      from(contentTypes).select("id", "label", "fields"),
    )
    return rows.filter(row => row.id !== exceptId && pointsTo(decodeArray<Field>(row.fields))).map(row => row.label)
  }

  return [
    get(
      "/types",
      read(async c => {
        const rows = await db.all<ContentTypeRow>(
          from(contentTypes).orderBy("sort_order", "ASC").orderBy("label", "ASC"),
        )
        return json(c, 200, { data: rows.map(present) })
      }),
    ),

    get(
      "/types/:name",
      read(async c => {
        const row = await byName(db, c.params.name ?? "")
        if (!row) throw notFound("Content type not found")
        const entryCount = await countRows(
          db,
          from("entries", "e")
            .select("COUNT(*) as total")
            .where(q => q("e.content_type_id").equals(row.id))
            .where(q => q("e.deleted_at").isNull()),
        )
        return json(c, 200, { ...present(row), entryCount })
      }),
    ),

    post(
      "/types",
      write(async c => {
        const input = body(c)
        const label = requireText(input, "label", "Label")
        const name = slugify(String(input.name ?? label)).replace(/-/g, "")

        if (!isHandle(name)) {
          throw badRequest("Name must be lowercase letters and digits, starting with a letter", { code: "BAD_NAME" })
        }
        if (await byName(db, name))
          throw conflict(`A content type named "${name}" already exists`, { code: "DUPLICATE" })

        const fields = parseFields(input.fields ?? [])
        await assertReferencesExist(fields, name)
        const kind = input.kind === "single" ? "single" : "collection"
        const timestamp = now()
        const row = {
          id: id(),
          name,
          label,
          plural_label: optionalText(input, "pluralLabel") ?? `${label}s`,
          description: optionalText(input, "description"),
          kind,
          preview_url: parsePreviewUrl(input.previewUrl),
          fields: encode(fields),
          icon: optionalText(input, "icon"),
          sort_order: Number(input.sortOrder ?? 0) || 0,
          owner_plugin: null,
          created_at: timestamp,
          updated_at: timestamp,
        }

        await db.execute(from(contentTypes).insert(row))
        return json(c, 201, present(row as ContentTypeRow))
      }),
    ),

    put(
      "/types/:name",
      write(async c => {
        const existing = await byName(db, c.params.name ?? "")
        if (!existing) throw notFound("Content type not found")
        if (existing.owner_plugin) {
          throw conflict(`"${existing.name}" is provided by the ${existing.owner_plugin} plugin and is edited there`, {
            code: "PLUGIN_OWNED",
          })
        }

        const input = body(c)
        const changes: Record<string, unknown> = { updated_at: now() }

        if (input.label !== undefined) changes.label = requireText(input, "label", "Label")
        if (input.pluralLabel !== undefined)
          changes.plural_label = optionalText(input, "pluralLabel") ?? existing.plural_label
        if (input.description !== undefined) changes.description = optionalText(input, "description")
        if (input.previewUrl !== undefined) changes.preview_url = parsePreviewUrl(input.previewUrl)
        if (input.icon !== undefined) changes.icon = optionalText(input, "icon")
        if (input.sortOrder !== undefined) changes.sort_order = Number(input.sortOrder) || 0
        if (input.fields !== undefined) {
          const fields = parseFields(input.fields)
          await assertReferencesExist(fields, existing.name)
          changes.fields = encode(fields)
        }

        await db.execute(
          from(contentTypes)
            .update(changes)
            .where(q => q("id").equals(existing.id)),
        )

        const updated = await byId(db, existing.id)
        return json(c, 200, present(updated as ContentTypeRow))
      }),
    ),

    del(
      "/types/:name",
      destroy(async c => {
        const existing = await byName(db, c.params.name ?? "")
        if (!existing) throw notFound("Content type not found")
        if (existing.owner_plugin) {
          throw conflict(
            `"${existing.name}" belongs to the ${existing.owner_plugin} plugin — disable the plugin instead`,
            {
              code: "PLUGIN_OWNED",
            },
          )
        }

        // Deleting a type would cascade every entry of that type, trashed ones
        // included. That is a one-way door, so it is refused while any row
        // survives — but the two counts are reported separately, because
        // GET /types/:name counts only live entries and an operator told
        // "still has 3 entries" about a type whose list reads empty has no way
        // to find them without knowing the trash also counts.
        const live = await countRows(
          db,
          from("entries", "e")
            .select("COUNT(*) as total")
            .where(q => q("e.content_type_id").equals(existing.id))
            .where(q => q("e.deleted_at").isNull()),
        )
        const trashed = await countRows(
          db,
          from("entries", "e")
            .select("COUNT(*) as total")
            .where(q => q("e.content_type_id").equals(existing.id))
            .where(q => q("e.deleted_at").isNotNull()),
        )

        if (live + trashed > 0) {
          const parts = [
            live > 0 ? `${live} ${live === 1 ? "entry" : "entries"}` : "",
            trashed > 0 ? `${trashed} in the trash` : "",
          ].filter(Boolean)
          throw conflict(`"${existing.name}" still has ${parts.join(" and ")}`, {
            code: "NOT_EMPTY",
            details: { entryCount: live, trashedCount: trashed },
          })
        }

        const referencedBy = await referencingTypes(existing.name, existing.id)
        if (referencedBy.length > 0) {
          throw conflict(
            `"${existing.label}" is referenced by ${referencedBy.join(", ")}. Remove those reference fields first.`,
            {
              code: "IN_USE",
              details: { contentTypes: referencedBy },
            },
          )
        }

        await db.execute(
          from(contentTypes)
            .where(q => q("id").equals(existing.id))
            .del(),
        )
        return json(c, 200, { deleted: true })
      }),
    ),
  ]
}
