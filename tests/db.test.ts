import { expect, test } from "bun:test"
import { from } from "atlas/db"
import { openDb } from "../src/db/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { taxonomies, terms } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"

test("SQLite enforces foreign-key cascades", async () => {
  const db = await openDb("sqlite://:memory:")
  await up(db, "./migrations")

  const taxonomyId = id()
  const termId = id()
  await db.execute(
    from(taxonomies).insert({
      id: taxonomyId,
      name: "topic",
      label: "Topic",
      hierarchical: 0,
      owner_plugin: null,
      created_at: now(),
    }),
  )
  await db.execute(
    from(terms).insert({
      id: termId,
      taxonomy_id: taxonomyId,
      parent_id: null,
      slug: "news",
      label: "News",
      description: null,
      sort_order: 0,
      created_at: now(),
    }),
  )

  await db.execute(
    from(taxonomies)
      .where(q => q("id").equals(taxonomyId))
      .del(),
  )

  expect(
    await db.one(
      from(terms)
        .select("id")
        .where(q => q("id").equals(termId)),
    ),
  ).toBeNull()
  await db.close()
})
