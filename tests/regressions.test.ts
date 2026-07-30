import { expect, test } from "bun:test"
import { connect, from } from "@atlas/db"
import { router } from "@atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { contentTypeRoutes } from "../src/contenttypes/index.ts"
import { embeds } from "../src/db/dialect.ts"
import { deliveryRoutes } from "../src/delivery/index.ts"
import { id, secretToken, sha256 } from "../src/ids/index.ts"
import { encode } from "../src/json/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { apiKeys, contentTypes, entries, entryTerms, taxonomies, terms as termsTable } from "../src/schema/index.ts"
import { createRateLimit } from "../src/security/index.ts"
import { makeKey } from "../src/storage/index.ts"
import { taxonomyRoutes } from "../src/taxonomy/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

// One test per fix from the code review, so each stays fixed.

const fresh = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  return db
}

test("filtering delivery by term uses a join, so a popular term does not blow the parameter ceiling", async () => {
  const db = await fresh()

  const key = secretToken("ink")
  await db.execute(
    from(apiKeys).insert({
      id: id(),
      name: "site",
      hashed_key: await sha256(key),
      prefix: key.slice(0, 12),
      scopes: encode([]),
      created_by: null,
      created_at: now(),
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    }),
  )

  const typeId = id()
  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "article",
      label: "Article",
      plural_label: "Articles",
      description: null,
      kind: "collection",
      preview_url: null,
      fields: encode([]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )

  const taxonomyId = id()
  await db.execute(
    from(taxonomies).insert({
      id: taxonomyId,
      name: "topic",
      label: "Topics",
      hierarchical: 0,
      owner_plugin: null,
      created_at: now(),
    }),
  )
  const termId = id()
  await db.execute(
    from(termsTable).insert({
      id: termId,
      taxonomy_id: taxonomyId,
      parent_id: null,
      slug: "popular",
      label: "Popular",
      description: null,
      sort_order: 0,
      created_at: now(),
    }),
  )

  // Comfortably past SQLite's default 32766-parameter ceiling had these ids been
  // passed as an IN list, which is what the old implementation did.
  const total = 1_200
  for (let index = 0; index < total; index += 1) {
    const entryId = id()
    await db.execute(
      from(entries).insert({
        id: entryId,
        content_type_id: typeId,
        slug: `post-${index}`,
        title: `Post ${index}`,
        data: encode({}),
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
    await db.execute(from(entryTerms).insert({ entry_id: entryId, term_id: termId }))
  }

  // One published entry deliberately left untagged, so the filter is doing work.
  await db.execute(
    from(entries).insert({
      id: id(),
      content_type_id: typeId,
      slug: "untagged",
      title: "Untagged",
      data: encode({}),
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

  const handle = router(
    ...deliveryRoutes(
      db,
      createHooks(() => {}),
    ),
  )
  const response = await handle(
    new Request("http://localhost/content/article?term=popular&limit=5", { headers: { "x-api-key": key } }),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as { data: unknown[]; meta: { total: number } }
  // The join keeps COUNT(*) exact — entry_terms is keyed on (entry_id, term_id),
  // so it cannot duplicate rows.
  expect(body.meta.total).toBe(total)
  expect(body.data).toHaveLength(5)

  const unfiltered = await handle(
    new Request("http://localhost/content/article?limit=1", { headers: { "x-api-key": key } }),
  )
  expect(((await unfiltered.json()) as { meta: { total: number } }).meta.total).toBe(total + 1)

  await db.close()
})

test("renaming a term onto a taken slug is a conflict, not a driver error", async () => {
  const db = await fresh()

  const editor = await createUser(db, {
    email: "editor@example.com",
    name: "Editor",
    password: "a secure password",
    role: "editor",
  })
  const token = (await issueSession(db, editor, { ip: "127.0.0.1", userAgent: "tests" })).token
  const handle = router(...taxonomyRoutes(db))
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

  await handle(
    new Request("http://localhost/taxonomies", {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Topics" }),
    }),
  )

  const create = (label: string) =>
    handle(
      new Request("http://localhost/taxonomies/topics/terms", {
        method: "POST",
        headers,
        body: JSON.stringify({ label }),
      }),
    )

  await create("News")
  const second = (await (await create("Reviews")).json()) as { id: string }

  // Creating a duplicate already returned a clean 409; renaming into one used to
  // surface the UNIQUE(taxonomy_id, slug) violation as a 500.
  const renamed = await handle(
    new Request(`http://localhost/terms/${second.id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ slug: "news" }),
    }),
  )
  expect(renamed.status).toBe(409)
  expect(((await renamed.json()) as { code: string }).code).toBe("DUPLICATE")

  // Renaming to something free still works, and to its own slug is a no-op.
  expect(
    (
      await handle(
        new Request(`http://localhost/terms/${second.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ slug: "opinion" }),
        }),
      )
    ).status,
  ).toBe(200)

  await db.close()
})

test("deleting a content type reports live and trashed entries separately", async () => {
  const db = await fresh()

  const admin = await createUser(db, {
    email: "admin@example.com",
    name: "Admin",
    password: "a secure password",
    role: "admin",
  })
  const token = (await issueSession(db, admin, { ip: "127.0.0.1", userAgent: "tests" })).token
  const handle = router(...contentTypeRoutes(db))
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

  const typeId = id()
  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "note",
      label: "Note",
      plural_label: "Notes",
      description: null,
      kind: "collection",
      preview_url: null,
      fields: encode([]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )

  // Only a trashed entry: the list screen shows this type as empty, so the
  // refusal has to say where the rows actually are.
  await db.execute(
    from(entries).insert({
      id: id(),
      content_type_id: typeId,
      slug: "gone",
      title: "Gone",
      data: encode({}),
      status: "draft",
      locale: "en",
      author_id: null,
      sort_order: 0,
      published_at: null,
      scheduled_at: null,
      created_at: now(),
      updated_at: now(),
      deleted_at: now(),
    }),
  )

  const read = await handle(new Request("http://localhost/types/note", { headers }))
  expect(((await read.json()) as { entryCount: number }).entryCount).toBe(0)

  const refused = await handle(new Request("http://localhost/types/note", { method: "DELETE", headers }))
  expect(refused.status).toBe(409)
  const body = (await refused.json()) as { error: string; details: { entryCount: number; trashedCount: number } }
  expect(body.details).toEqual({ entryCount: 0, trashedCount: 1 })
  expect(body.error).toContain("in the trash")

  await db.close()
})

test("the rate limiter counts every concurrent claim", async () => {
  const db = await fresh()
  const limiter = createRateLimit(db)

  // Fired together: the read-then-write version settled the counter at 1 here,
  // letting the effective limit drift above the configured one.
  const verdicts = await Promise.all(Array.from({ length: 5 }, () => limiter.check("bucket:concurrent", 5, 60)))
  expect(verdicts.every(verdict => verdict.ok)).toBe(true)

  // Five claims against a limit of five means the sixth is refused.
  const sixth = await limiter.check("bucket:concurrent", 5, 60)
  expect(sixth.ok).toBe(false)
  expect(sixth.retryAfter).toBeGreaterThan(0)

  // A separate bucket is unaffected, and clearing resets.
  expect((await limiter.check("bucket:other", 1, 60)).ok).toBe(true)
  await limiter.clear("bucket:concurrent")
  expect((await limiter.check("bucket:concurrent", 5, 60)).ok).toBe(true)

  await db.close()
})

test("the usage prefilter matches ids literally and escapes LIKE's own wildcards", async () => {
  const db = await fresh()

  await db.execute({
    text: "CREATE TABLE probe (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
    values: [],
  })
  const insert = (rowId: string, data: string) =>
    db.execute({ text: "INSERT INTO probe (id, data) VALUES (?, ?)", values: [rowId, data] })

  await insert("a", JSON.stringify({ hero: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }))
  await insert("b", JSON.stringify({ hero: "other-id" }))
  // A stored value that would match if % were treated as a wildcard.
  await insert("c", JSON.stringify({ hero: "prefix-anything-suffix" }))

  const found = await db.all<{ id: string }>(
    from("probe")
      .select("id")
      .where(q => q.raw(embeds("data", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"))),
  )
  expect(found.map(row => row.id)).toEqual(["a"])

  // The wildcard is escaped, so this needle matches nothing rather than everything.
  const wildcarded = await db.all<{ id: string }>(
    from("probe")
      .select("id")
      .where(q => q.raw(embeds("data", "prefix-%-suffix"))),
  )
  expect(wildcarded).toHaveLength(0)

  await db.close()
})

test("storage keys carry the randomness their justification claims", () => {
  const keys = Array.from({ length: 200 }, () => makeKey("logo.png"))

  // <year>/<month>/<16 hex>/<name> — 8 bytes, which is what the comment in
  // src/storage now says, rather than the 4 an earlier UUID slice gave.
  for (const key of keys) {
    expect(key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f]{16}\/logo\.png$/)
  }

  // Distinct, so two uploads of the same filename never collide.
  expect(new Set(keys).size).toBe(keys.length)

  // Traversal and separators are stripped from the caller-supplied name.
  expect(makeKey("../../etc/passwd")).toMatch(/^\d{4}\/\d{2}\/[0-9a-f]{16}\/etc-passwd$/)
})
