import { expect, test } from "bun:test"
import { connect, from } from "@atlas/db"
import { router } from "@atlas/server"
import { deliveryRoutes } from "../src/delivery/index.ts"
import { id, secretToken, sha256 } from "../src/ids/index.ts"
import { encode } from "../src/json/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { apiKeys, contentTypes, entries, media as mediaTable, users } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"

// Exercises the contract a consuming site actually depends on: key auth,
// published-only reads, media expansion, and the plugin filter.
const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

  const key = secretToken("ink")
  await db.execute(
    from(apiKeys).insert({
      id: id(),
      name: "test",
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

  const mediaId = id()
  await db.execute(
    from(mediaTable).insert({
      id: mediaId,
      filename: "cup.png",
      storage_key: "2026/07/abc/cup.png",
      url: "/media/file/2026/07/abc/cup.png",
      mime: "image/png",
      size: 1234,
      width: 800,
      height: 600,
      alt: "A cup",
      caption: null,
      folder: null,
      uploaded_by: null,
      created_at: now(),
      deleted_at: null,
    }),
  )

  const typeId = id()
  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "drink",
      label: "Drink",
      plural_label: "Drinks",
      description: null,
      kind: "collection",
      fields: encode([
        { key: "price", type: "number", label: "Price" },
        { key: "photo", type: "media", label: "Photo" },
      ]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )

  const insertEntry = (slug: string, title: string, status: string) =>
    db.execute(
      from(entries).insert({
        id: id(),
        content_type_id: typeId,
        slug,
        title,
        data: encode({ price: 7.5, photo: mediaId }),
        status,
        locale: "en",
        author_id: null,
        sort_order: 0,
        published_at: status === "published" ? now() : null,
        scheduled_at: null,
        created_at: now(),
        updated_at: now(),
        deleted_at: null,
      }),
    )

  await insertEntry("latte", "Latte", "published")
  await insertEntry("secret", "Secret Menu", "draft")

  const hooks = createHooks(() => {})
  const handle = router(...deliveryRoutes(db, hooks))
  const call = (path: string, headers: Record<string, string> = {}) =>
    handle(new Request(`http://localhost${path}`, { headers }))

  return { db, key, call, hooks }
}

test("rejects requests without a valid API key", async () => {
  const { call, db } = await setup()

  expect((await call("/content/drink")).status).toBe(401)
  expect((await call("/content/drink", { "x-api-key": "ink_wrong" })).status).toBe(401)

  await db.close()
})

test("returns published entries only, with media expanded", async () => {
  const { call, key, db } = await setup()

  const response = await call("/content/drink", { "x-api-key": key })
  expect(response.status).toBe(200)

  const body = (await response.json()) as any
  expect(body.meta.total).toBe(1)
  expect(body.data).toHaveLength(1)
  expect(body.data[0].title).toBe("Latte")

  // The media id is replaced by the object, so a site needs no second request.
  expect(body.data[0].data.photo).toMatchObject({ alt: "A cup", width: 800, mime: "image/png" })
  expect(body.data[0].data.price).toBe(7.5)
  expect(response.headers.get("cache-control")).toBe("private, max-age=30")
  expect(response.headers.get("vary")).toContain("x-api-key")

  await db.close()
})

test("a scoped key cannot expand a reference outside its scopes", async () => {
  const { call, db } = await setup()

  const drink = await db.one<{ id: string }>(
    from(contentTypes)
      .select("id")
      .where(q => q("name").equals("drink")),
  )
  const latte = await db.one<{ id: string }>(
    from(entries)
      .select("id")
      .where(q => q("slug").equals("latte")),
  )
  const secretTypeId = id()
  const secretEntryId = id()

  await db.execute(
    from(contentTypes).insert({
      id: secretTypeId,
      name: "secret",
      label: "Secret",
      plural_label: "Secrets",
      description: null,
      kind: "collection",
      fields: encode([]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )
  await db.execute(
    from(entries).insert({
      id: secretEntryId,
      content_type_id: secretTypeId,
      slug: "classified",
      title: "Classified",
      data: encode({ answer: 42 }),
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
  await db.execute(
    from(contentTypes)
      .update({ fields: encode([{ key: "related", type: "reference", label: "Related", of: "secret" }]) })
      .where(q => q("id").equals(drink?.id ?? "")),
  )
  await db.execute(
    from(entries)
      .update({ data: encode({ related: secretEntryId }) })
      .where(q => q("id").equals(latte?.id ?? "")),
  )

  const scoped = secretToken("ink")
  await db.execute(
    from(apiKeys).insert({
      id: id(),
      name: "drink-only",
      hashed_key: await sha256(scoped),
      prefix: scoped.slice(0, 12),
      scopes: encode(["drink"]),
      created_by: null,
      created_at: now(),
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    }),
  )

  const response = await call("/content/drink/latte", { "x-api-key": scoped })
  const payload = (await response.json()) as any
  expect(response.status).toBe(200)
  expect(payload.data.data.related).toBeNull()

  await db.close()
})

test("a draft is not reachable by slug", async () => {
  const { call, key, db } = await setup()

  expect((await call("/content/drink/latte", { "x-api-key": key })).status).toBe(200)
  expect((await call("/content/drink/secret", { "x-api-key": key })).status).toBe(404)

  await db.close()
})

test("a scoped key cannot read outside its scopes", async () => {
  const { call, db } = await setup()

  const scoped = secretToken("ink")
  await db.execute(
    from(apiKeys).insert({
      id: id(),
      name: "scoped",
      hashed_key: await sha256(scoped),
      prefix: scoped.slice(0, 12),
      scopes: encode(["somethingelse"]),
      created_by: null,
      created_at: now(),
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    }),
  )

  expect((await call("/content/drink", { "x-api-key": scoped })).status).toBe(403)
  await db.close()
})

test("a revoked key stops working", async () => {
  const { call, key, db } = await setup()

  const hashed = await sha256(key)
  await db.execute(
    from(apiKeys)
      .update({ revoked_at: now() })
      .where(q => q("hashed_key").equals(hashed)),
  )

  expect((await call("/content/drink", { "x-api-key": key })).status).toBe(401)
  await db.close()
})

test("plugins can reshape delivered entries through the filter", async () => {
  const { call, key, hooks, db } = await setup()

  hooks.addFilter("delivery.entry", "test", p => ({
    ...p,
    payload: { ...p.payload, badge: "featured" },
  }))

  const body = (await (await call("/content/drink", { "x-api-key": key })).json()) as any
  expect(body.data[0].badge).toBe("featured")

  await db.close()
})

test("a byline is opt-in, and never carries the author's email", async () => {
  const { call, key, db } = await setup()

  const authorId = id()
  await db.execute(
    from(users).insert({
      id: authorId,
      email: "karl@example.com",
      name: "Karl",
      role: "author",
      password_hash: "x",
      avatar_id: null,
      created_at: now(),
      updated_at: now(),
      last_seen_at: null,
      deleted_at: null,
    }),
  )
  await db.execute(
    from(entries)
      .update({ author_id: authorId })
      .where(q => q("slug").equals("latte")),
  )

  // Without asking, the payload carries no author key at all.
  const plain = (await (await call("/content/drink", { "x-api-key": key })).json()) as any
  expect(plain.data[0].author).toBeUndefined()

  const withAuthor = (await (await call("/content/drink?include=author", { "x-api-key": key })).json()) as any
  expect(withAuthor.data[0].author).toEqual({ name: "Karl", avatarUrl: null })
  expect(JSON.stringify(withAuthor)).not.toContain("karl@example.com")

  await db.close()
})

test("include accepts terms and author together", async () => {
  const { call, key, db } = await setup()

  const body = (await (await call("/content/drink?include=terms,author", { "x-api-key": key })).json()) as any
  expect(body.data[0].terms).toEqual([])
  // No author is assigned, so the key is present but null rather than missing.
  expect(body.data[0].author).toBeNull()

  await db.close()
})
