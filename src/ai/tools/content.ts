import { from } from "atlas/db"
import { can } from "../../auth/roles.ts"
import type { ContentTypeRow } from "../../contenttypes/index.ts"
import { present as presentType, byId as typeById, byName as typeByName } from "../../contenttypes/index.ts"
import { contains, rows } from "../../db/dialect.ts"
import type { EntryRow } from "../../entries/index.ts"
import type { Field } from "../../fields/index.ts"
import { decodeArray, decodeObject } from "../../json/index.ts"
import type { MediaRow } from "../../media/index.ts"
import { publicUrl } from "../../media/index.ts"
import { contentTypes, entries, media, taxonomies, terms } from "../../schema/index.ts"
import type { Tool, ToolRun } from "./common.ts"
import { clampLimit, fail, fieldShape, list, queued, readableData, record, text } from "./common.ts"

// Everything that is content: the shapes pages take, the pages themselves, the
// files they hang off, and the categories they are filed under.

type TaxonomyRow = { id: string; name: string; label: string; hierarchical: number }
type TermRow = { id: string; taxonomy_id: string; slug: string; label: string; parent_id: string | null }

const loadEntry = (run: ToolRun, entryId: string) =>
  run.db.one<EntryRow>(
    from(entries)
      .where(q => q("id").equals(entryId))
      .where(q => q("deleted_at").isNull()),
  )

const termsOf = async (run: ToolRun, entryId: string) =>
  rows<TermRow & { taxonomy_name: string }>(
    run.db,
    from("entry_terms", "et")
      .join("terms", "t.id = et.term_id", "t")
      .join("taxonomies", "tx.id = t.taxonomy_id", "tx")
      .select("t.id as id", "t.label as label", "t.slug as slug", "tx.name as taxonomy_name")
      .where(q => q("et.entry_id").equals(entryId)),
  )

export const contentTools: readonly Tool[] = [
  {
    name: "list_content_types",
    description:
      "List every content type on this site with its field shape. Call this first when you do not already know what a page or entry is made of — field keys here are the only valid keys in any entry's data.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.readContent,
    run: async run => {
      const all = await run.db.all<ContentTypeRow>(from(contentTypes).orderBy("sort_order", "ASC"))
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
    },
  },

  {
    name: "list_entries",
    description:
      "List entries of one content type, newest first. Use it to find the page you are being asked about, or to see how sibling pages are written before drafting a new one.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: 'The content type\'s name, e.g. "page".' },
        status: { type: "string", description: "Optional filter: draft, review, scheduled, published, or archived." },
        q: { type: "string", description: "Optional title search." },
        limit: { type: "number", description: "Up to 50. Defaults to 20." },
      },
      required: ["type"],
      additionalProperties: false,
    },
    needs: can.readContent,
    run: async (run, input) => {
      const type = await typeByName(run.db, text(input, "type"))
      if (!type) return fail(`No content type named "${text(input, "type")}". Call list_content_types.`)

      let query = from("entries", "e")
        .where(q => q("e.content_type_id").equals(type.id))
        .where(q => q("e.deleted_at").isNull())

      const status = text(input, "status")
      if (status) query = query.where(q => q("e.status").equals(status))
      const search = text(input, "q")
      if (search) query = query.where(q => q.raw(contains(run.db, "e.title", search)))

      const found = await rows<{ id: string; title: string; slug: string; status: string; updated_at: string }>(
        run.db,
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
    },
  },

  {
    name: "search_site",
    description:
      "Find a page or a file by name across every content type at once. Use this when someone names a page but not what kind of page it is — which is most of the time.",
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Words from the title or filename. At least two characters." },
        limit: { type: "number", description: "Up to 50. Defaults to 20." },
      },
      required: ["q"],
      additionalProperties: false,
    },
    needs: can.readContent,
    run: async (run, input) => {
      const term = text(input, "q")
      if (term.length < 2) return fail("Search for at least two characters.")
      const limit = clampLimit(input.limit)

      const found = await rows<{ id: string; title: string; slug: string; status: string; type_name: string }>(
        run.db,
        from("entries", "e")
          .join("content_types", "ct.id = e.content_type_id", "ct")
          .select("e.id as id", "e.title as title", "e.slug as slug", "e.status as status", "ct.name as type_name")
          .where(q => q("e.deleted_at").isNull())
          .where(q => q.raw(contains(run.db, "e.title", term)))
          .orderBy("e.updated_at", "DESC")
          .limit(limit),
      )

      const files = await run.db.all<MediaRow>(
        from(media)
          .where(q => q("deleted_at").isNull())
          .where(q => q.raw(contains(run.db, "filename", term)))
          .limit(limit),
      )

      return {
        output: {
          entries: found.map(row => ({
            id: row.id,
            type: row.type_name,
            title: row.title,
            slug: row.slug,
            status: row.status,
          })),
          media: files.map(row => ({ id: row.id, filename: row.filename, url: publicUrl(row.url), alt: row.alt })),
        },
      }
    },
  },

  {
    name: "get_entry",
    description:
      "Read one entry in full: its title, slug, status, every field value, and the categories it is filed under. Always read an entry before proposing a change to it — a patch built from a list summary will overwrite the parts you did not see.",
    input_schema: {
      type: "object",
      properties: { entryId: { type: "string" } },
      required: ["entryId"],
      additionalProperties: false,
    },
    needs: can.readContent,
    run: async (run, input) => {
      const entry = await loadEntry(run, text(input, "entryId"))
      if (!entry) return fail("No entry with that id — it may have been deleted.")
      const type = await typeById(run.db, entry.content_type_id)
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
          terms: (await termsOf(run, entry.id)).map(row => ({
            id: row.id,
            label: row.label,
            taxonomy: row.taxonomy_name,
          })),
        },
      }
    },
  },

  {
    name: "list_media",
    description:
      "List images and files already uploaded to this site. Media and gallery fields hold ids from here; never invent one. You cannot upload — send someone to the media library with open_screen when a file they want does not exist yet.",
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Optional filename or alt-text search." },
        limit: { type: "number", description: "Up to 50. Defaults to 20." },
      },
      additionalProperties: false,
    },
    needs: can.readContent,
    run: async (run, input) => {
      let query = from(media).where(q => q("deleted_at").isNull())
      const search = text(input, "q")
      if (search) query = query.where(q => q.raw(contains(run.db, "filename", search)))

      const found = await run.db.all<MediaRow>(query.orderBy("created_at", "DESC").limit(clampLimit(input.limit)))
      return {
        output: found.map(row => ({
          id: row.id,
          filename: row.filename,
          url: publicUrl(row.url),
          mime: row.mime,
          width: row.width,
          height: row.height,
          alt: row.alt,
          caption: row.caption,
        })),
      }
    },
  },

  {
    name: "list_taxonomies",
    description:
      "List the ways this site files its content — categories, tags, anything else — with every term in each. Terms are how a page is grouped without changing its shape.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.readContent,
    run: async run => {
      const all = await run.db.all<TaxonomyRow>(from(taxonomies).orderBy("label", "ASC"))
      const every = await run.db.all<TermRow>(from(terms).orderBy("sort_order", "ASC"))
      return {
        output: all.map(taxonomy => ({
          name: taxonomy.name,
          label: taxonomy.label,
          hierarchical: taxonomy.hierarchical === 1,
          terms: every
            .filter(term => term.taxonomy_id === taxonomy.id)
            .map(term => ({ id: term.id, label: term.label, slug: term.slug, parentId: term.parent_id })),
        })),
      }
    },
  },

  {
    name: "propose_entry_update",
    description:
      "Propose a change to an existing entry. This does not save anything — it queues the change for the person, who reviews a diff and applies it. Send only the fields you are changing; everything you omit is left exactly as it is.",
    input_schema: {
      type: "object",
      properties: {
        entryId: { type: "string" },
        summary: { type: "string", description: "One line, for the person: what this change does and why." },
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
    needs: can.writeContent,
    run: async (run, input) => {
      const entry = await loadEntry(run, text(input, "entryId"))
      if (!entry) return fail("No entry with that id — it may have been deleted.")
      const type = await typeById(run.db, entry.content_type_id)

      const patch: Record<string, unknown> = {}
      if (text(input, "title")) patch.title = text(input, "title")
      if (text(input, "slug")) patch.slug = text(input, "slug")
      const data = record(input, "data")
      if (Object.keys(data).length > 0) patch.data = data
      if (Object.keys(patch).length === 0) return fail("Nothing to change — send a title, a slug, or some data.")

      const stored = decodeObject(entry.data)
      const before: Record<string, unknown> = { title: entry.title, slug: entry.slug }
      for (const key of Object.keys(data)) before[key] = stored[key] ?? null

      run.queue({
        kind: "entry.update",
        summary: text(input, "summary") || "Update this entry",
        entryId: entry.id,
        entryTitle: entry.title,
        typeName: type?.name ?? "",
        patch,
        before,
      })

      return queued(
        "Shown to the person for review. Do not propose the same change twice; say what you queued and stop.",
      )
    },
  },

  {
    name: "propose_entry_create",
    description:
      "Propose a new entry. Like an update, this only queues it. Fill every required field of the content type; leave the status alone unless asked, so it arrives as a draft.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "The content type's name." },
        summary: { type: "string", description: "One line, for the person." },
        title: { type: "string" },
        slug: { type: "string", description: "Optional; one is derived from the title otherwise." },
        data: { type: "object", additionalProperties: true },
      },
      required: ["type", "summary", "title", "data"],
      additionalProperties: false,
    },
    needs: can.writeContent,
    run: async (run, input) => {
      const type = await typeByName(run.db, text(input, "type"))
      if (!type) return fail(`No content type named "${text(input, "type")}". Call list_content_types.`)
      if (!text(input, "title")) return fail("A new entry needs a title.")

      const payload: Record<string, unknown> = { title: text(input, "title"), data: record(input, "data") }
      if (text(input, "slug")) payload.slug = text(input, "slug")

      run.queue({
        kind: "entry.create",
        summary: text(input, "summary") || `New ${type.label}`,
        typeName: type.name,
        payload,
      })

      return queued()
    },
  },

  {
    name: "propose_entry_status",
    description:
      "Propose moving an entry between draft, review, published, and archived — this is how something you drafted goes live, or how a finished page is retired. Publishing revalidates the entry against its content type, so a draft missing a required field is refused rather than published broken.",
    input_schema: {
      type: "object",
      properties: {
        entryId: { type: "string" },
        status: { type: "string", description: "One of: draft, review, published, archived." },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["entryId", "status", "summary"],
      additionalProperties: false,
    },
    needs: can.writeContent,
    run: async (run, input) => {
      const entry = await loadEntry(run, text(input, "entryId"))
      if (!entry) return fail("No entry with that id — it may have been deleted.")

      const status = text(input, "status").toLowerCase()
      const allowed = ["draft", "review", "published", "archived"]
      if (!allowed.includes(status)) return fail(`\`status\` must be one of: ${allowed.join(", ")}.`)
      if (status === entry.status) return fail(`That entry is already ${status}.`)

      run.queue({
        kind: "entry.status",
        summary: text(input, "summary") || `Move to ${status}`,
        // Going live is a different permission from drafting, and it is the
        // same tool — so this one proposal carries the stricter requirement
        // rather than the tool's.
        needs: status === "published" ? can.publishContent.scope : can.writeContent.scope,
        entryId: entry.id,
        entryTitle: entry.title,
        from: entry.status,
        to: status,
      })

      return queued()
    },
  },

  {
    name: "propose_entry_delete",
    description:
      "Propose moving an entry to the trash. It is recoverable from the Trash screen, so this is not permanent — but it does take the page off the site. Prefer archiving something merely finished; delete what was a mistake.",
    input_schema: {
      type: "object",
      properties: {
        entryId: { type: "string" },
        summary: { type: "string", description: "One line, for the person: why this is going." },
      },
      required: ["entryId", "summary"],
      additionalProperties: false,
    },
    needs: can.writeContent,
    run: async (run, input) => {
      const entry = await loadEntry(run, text(input, "entryId"))
      if (!entry) return fail("No entry with that id — it may have been deleted already.")
      const type = await typeById(run.db, entry.content_type_id)

      run.queue({
        kind: "entry.delete",
        summary: text(input, "summary") || `Move "${entry.title}" to the trash`,
        entryId: entry.id,
        entryTitle: entry.title,
        typeName: type?.name ?? "",
      })

      return queued()
    },
  },

  {
    name: "propose_entry_terms",
    description:
      "Propose which categories or tags an entry is filed under. Send the complete list of term ids you want — it replaces what is there. Read the entry and list_taxonomies first.",
    input_schema: {
      type: "object",
      properties: {
        entryId: { type: "string" },
        termIds: { type: "array", items: { type: "string" }, description: "The complete set of term ids." },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["entryId", "termIds", "summary"],
      additionalProperties: false,
    },
    needs: can.writeContent,
    run: async (run, input) => {
      const entry = await loadEntry(run, text(input, "entryId"))
      if (!entry) return fail("No entry with that id — it may have been deleted.")

      const termIds = [...new Set(list(input, "termIds"))]
      const found = termIds.length ? await run.db.all<TermRow>(from(terms).where(q => q("id").inList(termIds))) : []
      if (found.length !== termIds.length) {
        return fail("One or more of those term ids do not exist. Call list_taxonomies for the real ones.")
      }

      run.queue({
        kind: "entry.terms",
        summary: text(input, "summary") || "Refile this entry",
        entryId: entry.id,
        entryTitle: entry.title,
        termIds,
        labels: found.map(term => term.label),
        before: (await termsOf(run, entry.id)).map(term => term.label),
      })

      return queued()
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
        summary: { type: "string", description: "One line, for the person." },
        fields: {
          type: "array",
          description: "The complete ordered field list, each with key, type, and label.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["type", "summary", "fields"],
      additionalProperties: false,
    },
    needs: can.manageTypes,
    run: async (run, input) => {
      const type = await typeByName(run.db, text(input, "type"))
      if (!type) return fail(`No content type named "${text(input, "type")}". Call list_content_types.`)
      if (type.owner_plugin) {
        return fail(`"${type.name}" belongs to the ${type.owner_plugin} plugin and cannot be edited here.`)
      }
      if (!Array.isArray(input.fields)) return fail("`fields` must be the complete ordered array of field definitions.")

      run.queue({
        kind: "type.update",
        summary: text(input, "summary") || `Update the ${type.label} model`,
        typeName: type.name,
        patch: { fields: input.fields },
        before: { fields: decodeArray<Field>(type.fields) },
      })

      return queued()
    },
  },

  {
    name: "propose_type_create",
    description:
      "Propose a brand new content type — the shape a new kind of page takes. Use this when what someone asked for has nowhere to live yet: a site with no `page` type that needs pages, a section of the site that is a different shape from everything else. Give it the fields that kind of page actually needs. If a suitable type already exists, add to that one with propose_type_update instead of making a near-duplicate.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Lowercase letters and digits only, no spaces or dashes, e.g. "page" or "casestudy".',
        },
        label: { type: "string", description: 'Singular, as a person would say it, e.g. "Page".' },
        pluralLabel: { type: "string", description: 'Plural, e.g. "Pages". Defaults to the label plus "s".' },
        kind: {
          type: "string",
          description:
            '"collection" for many entries (the usual), or "single" for exactly one — a homepage, an about page.',
        },
        summary: { type: "string", description: "One line, for the person." },
        fields: {
          type: "array",
          description: "The ordered field list, each with key, type, and label.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["name", "label", "summary", "fields"],
      additionalProperties: false,
    },
    needs: can.manageTypes,
    run: async (run, input) => {
      const name = text(input, "name").toLowerCase()
      if (!/^[a-z][a-z0-9]*$/.test(name)) {
        return fail(
          "`name` must be lowercase letters and digits starting with a letter — no spaces, dashes, or capitals.",
        )
      }
      if (await typeByName(run.db, name)) {
        return fail(`A content type named "${name}" already exists. Use propose_type_update to change it.`)
      }
      if (!text(input, "label")) return fail("A new content type needs a label.")
      if (!Array.isArray(input.fields) || input.fields.length === 0) {
        return fail("`fields` must be the ordered array of field definitions, and a type with no fields holds nothing.")
      }

      const payload: Record<string, unknown> = {
        name,
        label: text(input, "label"),
        fields: input.fields,
        kind: text(input, "kind") === "single" ? "single" : "collection",
      }
      if (text(input, "pluralLabel")) payload.pluralLabel = text(input, "pluralLabel")

      run.queue({
        kind: "type.create",
        summary: text(input, "summary") || `Add a ${text(input, "label")} content type`,
        typeName: name,
        payload,
      })

      return queued()
    },
  },

  {
    name: "propose_media_update",
    description:
      "Propose new alt text, a caption, or a folder for a file already uploaded. Alt text is what a screen reader says and what shows when an image fails to load, so it describes the picture rather than naming the file.",
    input_schema: {
      type: "object",
      properties: {
        mediaId: { type: "string", description: "From list_media." },
        alt: { type: "string" },
        caption: { type: "string" },
        folder: { type: "string" },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["mediaId", "summary"],
      additionalProperties: false,
    },
    needs: can.manageMedia,
    run: async (run, input) => {
      const row = await run.db.one<MediaRow>(
        from(media)
          .where(q => q("id").equals(text(input, "mediaId")))
          .where(q => q("deleted_at").isNull()),
      )
      if (!row) return fail("No file with that id — call list_media.")

      const patch: Record<string, unknown> = {}
      for (const key of ["alt", "caption", "folder"] as const) {
        if (input[key] !== undefined) patch[key] = text(input, key)
      }
      if (Object.keys(patch).length === 0) return fail("Nothing to change — send alt, caption, or folder.")

      run.queue({
        kind: "media.update",
        summary: text(input, "summary") || `Describe ${row.filename}`,
        mediaId: row.id,
        filename: row.filename,
        patch,
        before: { alt: row.alt, caption: row.caption, folder: row.folder },
      })

      return queued()
    },
  },

  {
    name: "propose_taxonomy_create",
    description:
      "Propose a new way of filing content — a set of categories, tags, or regions. Make one only when the grouping does not fit an existing taxonomy; a term inside one that already exists is nearly always the right answer.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: 'Plural, as a person would say it, e.g. "Categories".' },
        name: {
          type: "string",
          description: "Optional. Lowercase letters and digits; derived from the label if absent.",
        },
        hierarchical: { type: "boolean", description: "True if terms nest inside each other, like categories." },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["label", "summary"],
      additionalProperties: false,
    },
    needs: can.manageTaxonomy,
    run: async (run, input) => {
      const label = text(input, "label")
      if (!label) return fail("A new taxonomy needs a label.")

      const payload: Record<string, unknown> = { label, hierarchical: input.hierarchical === true }
      if (text(input, "name")) payload.name = text(input, "name")

      run.queue({
        kind: "taxonomy.create",
        summary: text(input, "summary") || `Add ${label}`,
        payload,
      })

      return queued()
    },
  },

  {
    name: "propose_term_create",
    description:
      "Propose a new term inside a taxonomy — one category, one tag. Call list_taxonomies first for the taxonomy's name and to check the term is not already there under another wording.",
    input_schema: {
      type: "object",
      properties: {
        taxonomy: { type: "string", description: "The taxonomy's name, from list_taxonomies." },
        label: { type: "string" },
        slug: { type: "string", description: "Optional; derived from the label otherwise." },
        parentId: { type: "string", description: "Optional term id, for a taxonomy that nests." },
        description: { type: "string" },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["taxonomy", "label", "summary"],
      additionalProperties: false,
    },
    needs: can.manageTaxonomy,
    run: async (run, input) => {
      const taxonomy = await run.db.one<TaxonomyRow>(
        from(taxonomies).where(q => q("name").equals(text(input, "taxonomy"))),
      )
      if (!taxonomy) return fail(`No taxonomy named "${text(input, "taxonomy")}". Call list_taxonomies.`)
      if (!text(input, "label")) return fail("A term needs a label.")

      const payload: Record<string, unknown> = { label: text(input, "label") }
      for (const key of ["slug", "parentId", "description"] as const) {
        if (text(input, key)) payload[key] = text(input, key)
      }

      run.queue({
        kind: "term.create",
        summary: text(input, "summary") || `Add "${text(input, "label")}" to ${taxonomy.label}`,
        taxonomyName: taxonomy.name,
        taxonomyLabel: taxonomy.label,
        payload,
      })

      return queued()
    },
  },
]
