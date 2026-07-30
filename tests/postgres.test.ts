import { afterAll, expect, test } from "bun:test"
import { connect, from } from "@atlas/db"
import { countRows } from "../src/db/dialect.ts"
import { id } from "../src/ids/index.ts"
import { encode } from "../src/json/index.ts"
import { down, scan, up } from "../src/migrate/index.ts"
import { contentTypes, entries } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"

// The portability claim in docs/ARCHITECTURE.md is only worth anything if it is
// actually exercised. These run against a real Postgres when TEST_POSTGRES_URL
// is set (or a local docker postgres is reachable) and skip otherwise, so the
// default `bun test` stays zero-setup.
const URL = process.env.TEST_POSTGRES_URL ?? "postgres://postgres:postgres@localhost:5432/inkling_test"

const reachable = await (async () => {
  try {
    const probe = connect({ driver: "postgres", url: URL })
    await probe.execute({ text: "SELECT 1", values: [] })
    await probe.close()
    return true
  } catch {
    return false
  }
})()

if (!reachable) {
  test.skip("postgres portability (set TEST_POSTGRES_URL to run)", () => {})
} else {
  const db = connect({ driver: "postgres", url: URL })

  afterAll(async () => {
    let next = await down(db, "./migrations")
    while (next) next = await down(db, "./migrations")
    await db.execute({ text: "DROP TABLE IF EXISTS schema_migrations", values: [] })
    await db.close()
  })

  test("the same migration set applies on postgres", async () => {
    // Start clean in case a previous run left tables behind.
    let previous = await down(db, "./migrations")
    while (previous) previous = await down(db, "./migrations")

    const ran = await up(db, "./migrations")
    expect(ran).toContain("00000001_users")
    // Every migration in the directory applied — derived, not a literal, so
    // adding one doesn't fail a test that has nothing to do with it.
    expect(ran).toHaveLength(scan("./migrations").length)

    const tables = await db.all<{ table_name: string }>({
      text: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
      values: [],
    })
    const names = tables.map(t => t.table_name)
    for (const name of ["users", "entries", "content_types", "media", "settings", "plugins"]) {
      expect(names).toContain(name)
    }
  })

  // The reason the schema uses TEXT ids, TEXT timestamps, TEXT json and INTEGER
  // booleans: every one of these round-trips to the same JS type it does on
  // SQLite, so no route module needs a per-dialect branch.
  test("rows come back with the same shapes SQLite produces", async () => {
    const typeId = id()
    await db.execute(
      from(contentTypes).insert({
        id: typeId,
        name: "portable",
        label: "Portable",
        plural_label: "Portables",
        description: null,
        kind: "collection",
        fields: encode([{ key: "price", type: "number", label: "Price" }]),
        icon: null,
        sort_order: 0,
        owner_plugin: null,
        created_at: now(),
        updated_at: now(),
      }),
    )

    const entryId = id()
    await db.execute(
      from(entries).insert({
        id: entryId,
        content_type_id: typeId,
        slug: "one",
        title: "One",
        data: encode({ price: 3 }),
        status: "published",
        locale: "en",
        author_id: null,
        sort_order: 0,
        published_at: now(),
        scheduled_at: null,
        created_at: now(),
        updated_at: now(),
        deleted_at: null,
      }),
    )

    const row = await db.one<Record<string, unknown>>(from(entries).where(q => q("id").equals(entryId)))
    expect(row).not.toBeNull()
    // Identifiers stay snake_case rather than folding to something else.
    expect(Object.keys(row as object)).toContain("content_type_id")
    expect(typeof row?.id).toBe("string")
    expect(typeof row?.created_at).toBe("string")
    // JSON stays a string, exactly as bun:sqlite returns it.
    expect(typeof row?.data).toBe("string")
    expect(typeof row?.sort_order).toBe("number")
  })

  test("upsert and COUNT behave the same as on sqlite", async () => {
    const { rateLimits } = await import("../src/schema/index.ts")

    for (const count of [1, 1]) {
      await db.execute(
        from(rateLimits)
          .insert({ bucket: "test:pg", count, window_started_at: now() })
          .onConflict({ target: ["bucket"], action: "update" }),
      )
    }

    // COUNT is BIGINT on postgres and may arrive as a string; countRows() is
    // the helper that normalizes it, which is why nothing reads .total directly.
    const total = await countRows(
      db,
      from("rate_limits")
        .select("COUNT(*) as total")
        .where(q => q("bucket").equals("test:pg")),
    )
    expect(total).toBe(1)
  })
}
