import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import { badRequest, conflict, del, forbidden, get, json, notFound, parseJson, pipeline, post, put } from "atlas/server"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { rows } from "../db/dialect.ts"
import { body, optionalText, requireText } from "../http/index.ts"
import { id, isHandle, slugify } from "../ids/index.ts"
import { fromBit } from "../json/index.ts"
import { entries, entryTerms, taxonomies, terms } from "../schema/index.ts"
import { now } from "../time/index.ts"

type TaxonomyRow = {
  id: string
  name: string
  label: string
  hierarchical: number
  owner_plugin: string | null
  created_at: string
}

type TermRow = {
  id: string
  taxonomy_id: string
  parent_id: string | null
  slug: string
  label: string
  description: string | null
  sort_order: number
  created_at: string
}

const presentTaxonomy = (row: TaxonomyRow) => ({
  id: row.id,
  name: row.name,
  label: row.label,
  hierarchical: fromBit(row.hierarchical),
  ownerPlugin: row.owner_plugin,
  createdAt: row.created_at,
})

const presentTerm = (row: TermRow) => ({
  id: row.id,
  taxonomyId: row.taxonomy_id,
  parentId: row.parent_id,
  slug: row.slug,
  label: row.label,
  description: row.description,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
})

export const termsForEntries = async (
  db: Connection,
  entryIds: readonly string[],
): Promise<Map<string, ReturnType<typeof presentTerm>[]>> => {
  const grouped = new Map<string, ReturnType<typeof presentTerm>[]>()
  if (entryIds.length === 0) return grouped

  const tagged = await rows<TermRow & { entry_id: string }>(
    db,
    from("entry_terms", "et")
      .join("terms", "t.id = et.term_id", "t")
      .select(
        "et.entry_id",
        "t.id",
        "t.taxonomy_id",
        "t.parent_id",
        "t.slug",
        "t.label",
        "t.description",
        "t.sort_order",
        "t.created_at",
      )
      .where(q => q("et.entry_id").inList(entryIds)),
  )

  for (const row of tagged) {
    const list = grouped.get(row.entry_id) ?? []
    list.push(presentTerm(row))
    grouped.set(row.entry_id, list)
  }
  return grouped
}

export const taxonomyRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db))
  const write = pipeline(requireAuth(db), requireCan(can.manageTaxonomy, "manage taxonomies"), parseJson)
  const act = pipeline(requireAuth(db), requireCan(can.manageTaxonomy, "manage taxonomies"))
  const assign = pipeline(requireAuth(db), requireCan(can.writeContent, "categorize content"), parseJson)

  const loadTaxonomy = async (name: string): Promise<TaxonomyRow> => {
    const row = await db.one<TaxonomyRow>(from(taxonomies).where(q => q("name").equals(name)))
    if (!row) throw notFound(`Taxonomy "${name}" not found`)
    return row
  }

  return [
    get(
      "/taxonomies",
      read(async c => {
        const rows = await db.all<TaxonomyRow>(from(taxonomies).orderBy("label", "ASC"))
        return json(c, 200, { data: rows.map(presentTaxonomy) })
      }),
    ),

    post(
      "/taxonomies",
      write(async c => {
        const input = body(c)
        const label = requireText(input, "label", "Label")
        const name = slugify(String(input.name ?? label)).replace(/-/g, "")
        if (!isHandle(name)) throw badRequest("Name must be lowercase letters and digits", { code: "BAD_NAME" })

        const existing = await db.one(from(taxonomies).where(q => q("name").equals(name)))
        if (existing) throw conflict(`A taxonomy named "${name}" already exists`, { code: "DUPLICATE" })

        const row: TaxonomyRow = {
          id: id(),
          name,
          label,
          hierarchical: input.hierarchical ? 1 : 0,
          owner_plugin: null,
          created_at: now(),
        }
        await db.execute(from(taxonomies).insert(row))
        return json(c, 201, presentTaxonomy(row))
      }),
    ),

    del(
      "/taxonomies/:name",
      act(async c => {
        const taxonomy = await loadTaxonomy(c.params.name ?? "")
        if (taxonomy.owner_plugin) {
          throw conflict(`"${taxonomy.name}" belongs to the ${taxonomy.owner_plugin} plugin`, { code: "PLUGIN_OWNED" })
        }
        // terms and entry_terms cascade from the FK.
        await db.execute(
          from(taxonomies)
            .where(q => q("id").equals(taxonomy.id))
            .del(),
        )
        return json(c, 200, { deleted: true })
      }),
    ),

    get(
      "/taxonomies/:name/terms",
      read(async c => {
        const taxonomy = await loadTaxonomy(c.params.name ?? "")
        const rows = await db.all<TermRow>(
          from(terms)
            .where(q => q("taxonomy_id").equals(taxonomy.id))
            .orderBy("sort_order", "ASC")
            .orderBy("label", "ASC"),
        )
        return json(c, 200, { data: rows.map(presentTerm) })
      }),
    ),

    post(
      "/taxonomies/:name/terms",
      write(async c => {
        const taxonomy = await loadTaxonomy(c.params.name ?? "")
        const input = body(c)
        const label = requireText(input, "label", "Label")
        const slug = slugify(optionalText(input, "slug") ?? label)

        const clash = await db.one(
          from(terms)
            .select("id")
            .where(q => q("taxonomy_id").equals(taxonomy.id))
            .where(q => q("slug").equals(slug)),
        )
        if (clash) throw conflict(`A term with slug "${slug}" already exists here`, { code: "DUPLICATE" })

        const parentId = optionalText(input, "parentId")
        if (parentId) {
          const parent = await db.one<{ id: string; taxonomy_id: string }>(
            from(terms)
              .select("id", "taxonomy_id")
              .where(q => q("id").equals(parentId)),
          )
          if (!parent || parent.taxonomy_id !== taxonomy.id) {
            throw badRequest("Parent term must belong to the same taxonomy", { code: "BAD_PARENT" })
          }
        }

        const row: TermRow = {
          id: id(),
          taxonomy_id: taxonomy.id,
          parent_id: parentId,
          slug,
          label,
          description: optionalText(input, "description"),
          sort_order: Number(input.sortOrder ?? 0) || 0,
          created_at: now(),
        }
        await db.execute(from(terms).insert(row))
        return json(c, 201, presentTerm(row))
      }),
    ),

    put(
      "/terms/:id",
      write(async c => {
        const row = await db.one<TermRow>(from(terms).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Term not found")

        const input = body(c)
        const changes: Record<string, unknown> = {}
        if (input.label !== undefined) changes.label = requireText(input, "label", "Label")
        if (input.description !== undefined) changes.description = optionalText(input, "description")
        if (input.sortOrder !== undefined) changes.sort_order = Number(input.sortOrder) || 0
        if (input.slug !== undefined) {
          const slug = slugify(requireText(input, "slug", "Slug"))
          // (taxonomy_id, slug) is UNIQUE in the schema, so without this the
          // driver's constraint error surfaces as a 500 — while the create path
          // right above returns a clean 409 for the same collision.
          if (slug !== row.slug) {
            const clash = await db.one(
              from(terms)
                .select("id")
                .where(q => q("taxonomy_id").equals(row.taxonomy_id))
                .where(q => q("slug").equals(slug)),
            )
            if (clash) throw conflict(`A term with slug "${slug}" already exists here`, { code: "DUPLICATE" })
          }
          changes.slug = slug
        }

        if (Object.keys(changes).length > 0) {
          await db.execute(
            from(terms)
              .update(changes)
              .where(q => q("id").equals(row.id)),
          )
        }
        return json(c, 200, presentTerm({ ...row, ...changes } as TermRow))
      }),
    ),

    del(
      "/terms/:id",
      act(async c => {
        const row = await db.one<TermRow>(from(terms).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Term not found")
        await db.execute(
          from(terms)
            .where(q => q("id").equals(row.id))
            .del(),
        )
        return json(c, 200, { deleted: true })
      }),
    ),

    // Replaces an entry's whole term set — simpler to reason about from an
    // editor than add/remove deltas, and idempotent on retry.
    put(
      "/entries/:id/terms",
      assign(async c => {
        const entryId = c.params.id ?? ""
        const entry = await db.one<{ id: string; author_id: string | null }>(
          from(entries)
            .select("id", "author_id")
            .where(q => q("id").equals(entryId))
            .where(q => q("deleted_at").isNull()),
        )
        if (!entry) throw notFound("Entry not found")
        const identity = auth(c)
        if (!can.publishContent(identity.role) && entry.author_id !== identity.id) {
          throw forbidden("You can only categorize entries you authored", { code: "NOT_YOURS" })
        }

        const raw = body(c).termIds
        if (!Array.isArray(raw) || raw.some(v => typeof v !== "string")) {
          throw badRequest("termIds must be an array of term ids", { code: "BAD_TERMS" })
        }
        const termIds = [...new Set(raw as string[])]

        if (termIds.length > 0) {
          const found = await db.all<{ id: string }>(
            from(terms)
              .select("id")
              .where(q => q("id").inList(termIds)),
          )
          if (found.length !== termIds.length)
            throw badRequest("One or more term ids do not exist", { code: "BAD_TERMS" })
        }

        await db.transaction(async tx => {
          await tx.execute(
            from(entryTerms)
              .where(q => q("entry_id").equals(entryId))
              .del(),
          )
          if (termIds.length > 0) {
            await tx.execute(
              from(entryTerms).insertMany(termIds.map(termId => ({ entry_id: entryId, term_id: termId }))),
            )
          }
        })

        return json(c, 200, { entryId, termIds })
      }),
    ),

    get(
      "/entries/:id/terms",
      read(async c => {
        const grouped = await termsForEntries(db, [c.params.id ?? ""])
        return json(c, 200, { data: grouped.get(c.params.id ?? "") ?? [] })
      }),
    ),
  ]
}
