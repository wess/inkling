import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Route } from "@atlas/server"
import { get, json, pipeline } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { contains, countRows, paging, rows } from "../db/dialect.ts"

// Admin-side search across entries and media. Deliberately a LIKE scan rather
// than a full-text index: it stays identical on Postgres and SQLite, and a CMS
// admin searching its own content is a low-cardinality, low-frequency query.
// If a site outgrows this, the honest fix is a real index, not a cleverer LIKE.
export const searchRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db))

  return [
    get(
      "/search",
      read(async c => {
        const term = (c.query.q ?? "").trim()
        if (term.length < 2) return json(c, 200, { data: { entries: [], media: [] }, meta: { query: term } })

        const { limit } = paging(c.query, 10, 50)

        const entryRows = await rows<{
          id: string
          slug: string
          title: string
          status: string
          updated_at: string
          type_name: string
          type_label: string
        }>(
          db,
          from("entries", "e")
            .join("content_types", "ct.id = e.content_type_id", "ct")
            .select(
              "e.id",
              "e.slug",
              "e.title",
              "e.status",
              "e.updated_at",
              "ct.name as type_name",
              "ct.label as type_label",
            )
            .where(q => q("e.deleted_at").isNull())
            .where(q => q.raw(contains(db, "e.title", term)))
            .orderBy("e.updated_at", "DESC")
            .limit(limit),
        )

        const mediaRows = await rows<{ id: string; filename: string; url: string; mime: string }>(
          db,
          from("media")
            .select("id", "filename", "url", "mime")
            .where(q => q("deleted_at").isNull())
            .where(q => q.raw(contains(db, "filename", term)))
            .orderBy("created_at", "DESC")
            .limit(limit),
        )

        return json(c, 200, {
          data: {
            entries: entryRows.map(row => ({
              id: row.id,
              slug: row.slug,
              title: row.title,
              status: row.status,
              updatedAt: row.updated_at,
              type: { name: row.type_name, label: row.type_label },
            })),
            media: mediaRows,
          },
          meta: { query: term },
        })
      }),
    ),

    // Powers the admin dashboard.
    get(
      "/stats",
      read(async c => {
        const entryCount = await countRows(
          db,
          from("entries", "e")
            .select("COUNT(*) as total")
            .where(q => q("e.deleted_at").isNull()),
        )
        const publishedCount = await countRows(
          db,
          from("entries", "e")
            .select("COUNT(*) as total")
            .where(q => q("e.deleted_at").isNull())
            .where(q => q("e.status").equals("published")),
        )
        const draftCount = await countRows(
          db,
          from("entries", "e")
            .select("COUNT(*) as total")
            .where(q => q("e.deleted_at").isNull())
            .where(q => q("e.status").equals("draft")),
        )
        const reviewCount = await countRows(
          db,
          from("entries", "e")
            .select("COUNT(*) as total")
            .where(q => q("e.deleted_at").isNull())
            .where(q => q("e.status").equals("review")),
        )
        const scheduledCount = await countRows(
          db,
          from("entries", "e")
            .select("COUNT(*) as total")
            .where(q => q("e.deleted_at").isNull())
            .where(q => q("e.status").equals("scheduled")),
        )
        const mediaCount = await countRows(
          db,
          from("media", "m")
            .select("COUNT(*) as total")
            .where(q => q("m.deleted_at").isNull()),
        )
        const typeCount = await countRows(db, from("content_types", "ct").select("COUNT(*) as total"))

        const recent = await rows<{ id: string; title: string; status: string; updated_at: string; type_name: string }>(
          db,
          from("entries", "e")
            .join("content_types", "ct.id = e.content_type_id", "ct")
            .select("e.id", "e.title", "e.status", "e.updated_at", "ct.name as type_name")
            .where(q => q("e.deleted_at").isNull())
            .orderBy("e.updated_at", "DESC")
            .limit(8),
        )

        return json(c, 200, {
          data: {
            entries: entryCount,
            published: publishedCount,
            drafts: draftCount,
            review: reviewCount,
            scheduled: scheduledCount,
            media: mediaCount,
            types: typeCount,
            recent: recent.map(row => ({
              id: row.id,
              title: row.title,
              status: row.status,
              updatedAt: row.updated_at,
              type: row.type_name,
            })),
          },
        })
      }),
    ),
  ]
}
