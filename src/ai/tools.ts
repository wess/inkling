import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { ContentTypeRow } from "../contenttypes/index.ts"
import { present as presentType, byId as typeById, byName as typeByName } from "../contenttypes/index.ts"
import { contains, rows } from "../db/dialect.ts"
import type { EntryRow } from "../entries/index.ts"
import type { Field } from "../fields/index.ts"
import { decodeArray, decodeObject } from "../json/index.ts"
import type { MediaRow } from "../media/index.ts"
import { publicUrl } from "../media/index.ts"
import { contentTypes, entries, media } from "../schema/index.ts"

// What the agent is allowed to know and allowed to ask for.
//
// The split below is the whole safety model, so it is worth stating plainly:
// every tool here is a *read*. The agent cannot write, and there is no flag that
// makes it able to — a change reaches content only when an editor clicks Apply
// in the admin, which sends it back through PUT /entries/:id like any other
// edit. That keeps one write path in the codebase, so revisions, validation,
// slug uniqueness, relation checks, hooks, and the audit trail all keep working
// without a second implementation that has to be kept honest.
//
// The "write" tools the model sees (`propose_*`) therefore do nothing but
// record an intention and hand it to the UI.

export type ToolContext = {
  readonly db: Connection
  readonly proposals: Proposal[]
}

// A change the agent wants made, in exactly the shape the admin already knows
// how to send. `summary` is the model's own one-line description; it is shown to
// the editor, never trusted as a description of what the payload does.
export type Proposal =
  | {
      readonly kind: "entry.update"
      readonly id: string
      readonly summary: string
      readonly entryId: string
      readonly entryTitle: string
      readonly typeName: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    }
  | {
      readonly kind: "entry.create"
      readonly id: string
      readonly summary: string
      readonly typeName: string
      readonly payload: Record<string, unknown>
    }
  | {
      readonly kind: "type.update"
      readonly id: string
      readonly summary: string
      readonly typeName: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    }

export type ToolSpec = {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
}

const MAX_ROWS = 50
const MAX_FIELD_EXCERPT = 4_000

const clampLimit = (raw: unknown): number => {
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 20
  return Math.min(Math.floor(value), MAX_ROWS)
}

const text = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : ""

const record = (input: Record<string, unknown>, key: string): Record<string, unknown> =>
  input[key] !== null && typeof input[key] === "object" && !Array.isArray(input[key])
    ? (input[key] as Record<string, unknown>)
    : {}

// Media and reference fields hold ids, which tell the model nothing on their
// own; long bodies are trimmed because the agent needs the gist and the shape,
// not every byte.
const readableData = (fields: readonly Field[], data: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = data[field.key]
    if (value === null || value === undefined || value === "") continue
    out[field.key] = typeof value === "string" ? value.slice(0, MAX_FIELD_EXCERPT) : value
  }
  return out
}

type FieldShape = {
  key: string
  type: string
  label: string
  required: boolean
  help?: string
  options?: string[]
  of?: string
  fields?: FieldShape[]
}

const fieldShape = (fields: readonly Field[]): FieldShape[] =>
  fields.map(field => ({
    key: field.key,
    type: field.type,
    label: field.label,
    required: field.required ?? false,
    help: field.help,
    options: field.options?.map(option => option.value),
    of: field.of,
    fields: field.fields ? fieldShape(field.fields) : undefined,
  }))

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "list_content_types",
    description:
      "List every content type on this site with its field shape. Call this first when you do not already know what a page or entry is made of — field keys here are the only valid keys in any entry's data.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_entries",
    description:
      "List entries of one content type, newest first. Use it to find the page you are being asked about, or to see how sibling pages are written before drafting a new one.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: 'The content type\'s name, e.g. "page".' },
        status: {
          type: "string",
          description: "Optional filter: draft, review, scheduled, published, or archived.",
        },
        q: { type: "string", description: "Optional title search." },
        limit: { type: "number", description: "Up to 50. Defaults to 20." },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  {
    name: "get_entry",
    description:
      "Read one entry in full: its title, slug, status, and every field value. Always read an entry before proposing a change to it — a patch built from a list summary will overwrite the parts you did not see.",
    input_schema: {
      type: "object",
      properties: { entryId: { type: "string" } },
      required: ["entryId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_media",
    description:
      "List images and files already uploaded to this site. Media and gallery fields hold ids from here; never invent one.",
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Optional filename or alt-text search." },
        limit: { type: "number", description: "Up to 50. Defaults to 20." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "propose_entry_update",
    description:
      "Propose a change to an existing entry. This does not save anything — it queues the change for the editor, who reviews a diff and applies it. Send only the fields you are changing; everything you omit is left exactly as it is.",
    input_schema: {
      type: "object",
      properties: {
        entryId: { type: "string" },
        summary: { type: "string", description: "One line, for the editor: what this change does and why." },
        title: { type: "string" },
        slug: { type: "string" },
        data: {
          type: "object",
          description: "Field values to change, keyed by the content type's field keys.",
          additionalProperties: true,
        },
      },
      required: ["entryId", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_entry_create",
    description:
      "Propose a new entry. Like an update, this only queues it for the editor. Fill every required field of the content type; leave the status alone unless asked, so it arrives as a draft.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "The content type's name." },
        summary: { type: "string", description: "One line, for the editor." },
        title: { type: "string" },
        slug: { type: "string", description: "Optional; one is derived from the title otherwise." },
        data: { type: "object", additionalProperties: true },
      },
      required: ["type", "summary", "title", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_type_update",
    description:
      "Propose a change to a content type's fields — this is how a page gains a new section or loses one. Send the complete field list you want, not a partial one: it replaces the existing list. Read the type first, and preserve the key of every field whose content should survive, because entry data is keyed by it.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "The content type's name." },
        summary: { type: "string", description: "One line, for the editor." },
        fields: {
          type: "array",
          description: "The complete ordered field list, each with key, type, and label.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["type", "summary", "fields"],
      additionalProperties: false,
    },
  },
]

const proposalId = (): string => `p_${Math.random().toString(36).slice(2, 10)}`

// Errors are returned as text rather than thrown: a tool that fails should let
// the model correct itself on the next step, not end the run.
export const runTool = async (
  context: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<{ readonly output: unknown; readonly isError?: boolean }> => {
  const { db } = context
  const fail = (message: string) => ({ output: { error: message }, isError: true })

  const loadType = async (typeName: string) => {
    const row = await typeByName(db, typeName)
    return row ?? null
  }

  const loadEntry = async (entryId: string) =>
    db.one<EntryRow>(
      from(entries)
        .where(q => q("id").equals(entryId))
        .where(q => q("deleted_at").isNull()),
    )

  switch (name) {
    case "list_content_types": {
      const all = await db.all<ContentTypeRow>(from(contentTypes).orderBy("sort_order", "ASC"))
      return {
        output: all.map(row => {
          const type = presentType(row)
          return {
            name: type.name,
            label: type.label,
            kind: type.kind,
            description: type.description,
            ownedByPlugin: type.ownerPlugin,
            fields: fieldShape(type.fields),
          }
        }),
      }
    }

    case "get_entry": {
      const entry = await loadEntry(text(input, "entryId"))
      if (!entry) return fail("No entry with that id — it may have been deleted.")
      const type = await typeById(db, entry.content_type_id)
      const fields = type ? decodeArray<Field>(type.fields) : []
      return {
        output: {
          id: entry.id,
          type: type?.name ?? null,
          title: entry.title,
          slug: entry.slug,
          status: entry.status,
          locale: entry.locale,
          updatedAt: entry.updated_at,
          fields: fieldShape(fields),
          data: readableData(fields, decodeObject(entry.data)),
        },
      }
    }

    case "list_entries": {
      const type = await loadType(text(input, "type"))
      if (!type) return fail(`No content type named "${text(input, "type")}". Call list_content_types.`)

      let query = from("entries", "e")
        .where(q => q("e.content_type_id").equals(type.id))
        .where(q => q("e.deleted_at").isNull())

      const status = text(input, "status")
      if (status) query = query.where(q => q("e.status").equals(status))
      const search = text(input, "q")
      if (search) query = query.where(q => q.raw(contains(db, "e.title", search)))

      const found = await rows<{ id: string; title: string; slug: string; status: string; updated_at: string }>(
        db,
        query
          .select(
            "e.id as id",
            "e.title as title",
            "e.slug as slug",
            "e.status as status",
            "e.updated_at as updated_at",
          )
          .orderBy("e.updated_at", "DESC")
          .limit(clampLimit(input.limit)),
      )

      return {
        output: found.map(row => ({
          id: row.id,
          title: row.title,
          slug: row.slug,
          status: row.status,
          updatedAt: row.updated_at,
        })),
      }
    }

    case "list_media": {
      let query = from(media).where(q => q("deleted_at").isNull())
      const search = text(input, "q")
      if (search) query = query.where(q => q.raw(contains(db, "filename", search)))

      const found = await db.all<MediaRow>(query.orderBy("created_at", "DESC").limit(clampLimit(input.limit)))
      return {
        output: found.map(row => ({
          id: row.id,
          filename: row.filename,
          url: publicUrl(row.url),
          mime: row.mime,
          width: row.width,
          height: row.height,
          alt: row.alt,
        })),
      }
    }

    case "propose_entry_update": {
      const entry = await loadEntry(text(input, "entryId"))
      if (!entry) return fail("No entry with that id — it may have been deleted.")
      const type = await typeById(db, entry.content_type_id)

      const patch: Record<string, unknown> = {}
      if (text(input, "title")) patch.title = text(input, "title")
      if (text(input, "slug")) patch.slug = text(input, "slug")
      const data = record(input, "data")
      if (Object.keys(data).length > 0) patch.data = data
      if (Object.keys(patch).length === 0) return fail("Nothing to change — send a title, a slug, or some data.")

      const stored = decodeObject(entry.data)
      const before: Record<string, unknown> = { title: entry.title, slug: entry.slug }
      for (const key of Object.keys(data)) before[key] = stored[key] ?? null

      context.proposals.push({
        kind: "entry.update",
        id: proposalId(),
        summary: text(input, "summary") || "Update this entry",
        entryId: entry.id,
        entryTitle: entry.title,
        typeName: type?.name ?? "",
        patch,
        before,
      })

      return {
        output: {
          queued: true,
          note: "Shown to the editor for review. Do not propose the same change twice; say what you queued and stop.",
        },
      }
    }

    case "propose_entry_create": {
      const type = await loadType(text(input, "type"))
      if (!type) return fail(`No content type named "${text(input, "type")}". Call list_content_types.`)
      if (!text(input, "title")) return fail("A new entry needs a title.")

      const payload: Record<string, unknown> = { title: text(input, "title"), data: record(input, "data") }
      if (text(input, "slug")) payload.slug = text(input, "slug")

      context.proposals.push({
        kind: "entry.create",
        id: proposalId(),
        summary: text(input, "summary") || `New ${type.label}`,
        typeName: type.name,
        payload,
      })

      return { output: { queued: true, note: "Shown to the editor for review. Do not queue it again." } }
    }

    case "propose_type_update": {
      const type = await loadType(text(input, "type"))
      if (!type) return fail(`No content type named "${text(input, "type")}". Call list_content_types.`)
      if (type.owner_plugin) {
        return fail(`"${type.name}" belongs to the ${type.owner_plugin} plugin and cannot be edited here.`)
      }
      if (!Array.isArray(input.fields)) return fail("`fields` must be the complete ordered array of field definitions.")

      context.proposals.push({
        kind: "type.update",
        id: proposalId(),
        summary: text(input, "summary") || `Update the ${type.label} model`,
        typeName: type.name,
        patch: { fields: input.fields },
        before: { fields: decodeArray<Field>(type.fields) },
      })

      return { output: { queued: true, note: "Shown to the editor for review. Do not queue it again." } }
    }

    default:
      return fail(`No tool named "${name}".`)
  }
}
