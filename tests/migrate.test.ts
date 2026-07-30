import { expect, test } from "bun:test"
import { connect } from "@atlas/db"
import { down, scan, splitStatements, up } from "../src/migrate/index.ts"

const fresh = () => connect({ driver: "sqlite", path: ":memory:" })

const tableNames = async (db: ReturnType<typeof fresh>) => {
  const rows = await db.all<{ name: string }>({
    text: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    values: [],
  })
  return rows.map(r => r.name)
}

test("splits on statement-terminating semicolons only", () => {
  expect(splitStatements("CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);")).toHaveLength(2)
  expect(splitStatements("INSERT INTO a VALUES ('x;y');")).toEqual(["INSERT INTO a VALUES ('x;y')"])
  expect(splitStatements("SELECT 1; -- trailing; comment\nSELECT 2;")).toHaveLength(2)
  expect(splitStatements("/* a; b */ SELECT 1;")).toHaveLength(1)
  expect(splitStatements("INSERT INTO a VALUES ('it''s; fine');")).toHaveLength(1)
  expect(splitStatements("DO $$ BEGIN raise notice 'a;b'; END $$;")).toHaveLength(1)
  expect(splitStatements("SELECT 1")).toEqual(["SELECT 1"])
  expect(splitStatements("   ;;  ")).toEqual([])
})

// Guards the reason this runner exists: bun:sqlite's prepare().run() executes
// only the first statement of a multi-statement string, so every table in a
// migration file must be created individually.
test("applies every statement in each migration file", async () => {
  const db = fresh()
  const ran = await up(db, "./migrations")

  expect(ran).toContain("00000001_users")
  expect(ran).toContain("00000010_ops")

  const tables = await tableNames(db)
  for (const name of [
    "users",
    "sessions",
    "content_types",
    "entries",
    "revisions",
    "media",
    "taxonomies",
    "terms",
    "entry_terms",
    "menus",
    "settings",
    "api_keys",
    "webhooks",
    "plugins",
    "audit_events",
    "rate_limits",
  ]) {
    expect(tables).toContain(name)
  }
  await db.close()
})

test("is idempotent across reruns", async () => {
  const db = fresh()
  await up(db, "./migrations")
  expect(await up(db, "./migrations")).toEqual([])
  await db.close()
})

test("rolls every migration back", async () => {
  const db = fresh()
  await up(db, "./migrations")

  // Counted from the directory rather than hardcoded: the assertion that matters
  // is "every migration rolled back", and a literal here just breaks every time
  // one is added.
  let rolled = 0
  while (await down(db, "./migrations")) rolled++
  expect(rolled).toBe(scan("./migrations").length)

  expect(await tableNames(db)).toEqual(["schema_migrations"])
  await db.close()
})

test("namespaces plugin migrations separately from core", async () => {
  const db = fresh()
  await up(db, "./migrations")
  const ran = await up(db, "./tests/fixtures/pluginmigrations", "plugin:demo")
  expect(ran).toEqual(["plugin:demo/00000001_sample"])
  await db.close()
})

test("rolls back a migration when one statement fails", async () => {
  const db = fresh()

  await expect(up(db, "./tests/fixtures/migrations")).rejects.toThrow()
  expect(await tableNames(db)).not.toContain("should_rollback")

  const recorded = await db.all<{ name: string }>({
    text: "SELECT name FROM schema_migrations WHERE name = ?",
    values: ["00000001failure"],
  })
  expect(recorded).toEqual([])
  await db.close()
})
