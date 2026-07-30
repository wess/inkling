import { expect, test } from "bun:test"
import { connect, from } from "@atlas/db"
import { router } from "@atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { entryRoutes } from "../src/entries/index.ts"
import { id } from "../src/ids/index.ts"
import { encode } from "../src/json/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { contentTypes, entries } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

// Bulk exists to save clicks, not to skip rules — most of this file is about the
// second half of that sentence.

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

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
      // `body` is required, which is how one entry in a selection can fail to
      // publish while its neighbours succeed.
      fields: encode([{ key: "body", type: "textarea", label: "Body", required: true }]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )

  const editor = await createUser(db, {
    email: "editor@example.com",
    name: "Editor",
    password: "a secure password",
    role: "editor",
  })
  const author = await createUser(db, {
    email: "author@example.com",
    name: "Author",
    password: "a secure password",
    role: "author",
  })

  const insert = async (slug: string, data: Record<string, unknown>, authorId: string) => {
    const entryId = id()
    await db.execute(
      from(entries).insert({
        id: entryId,
        content_type_id: typeId,
        slug,
        title: slug,
        data: encode(data),
        status: "draft",
        locale: "en",
        author_id: authorId,
        sort_order: 0,
        published_at: null,
        scheduled_at: null,
        created_at: now(),
        updated_at: now(),
        deleted_at: null,
      }),
    )
    return entryId
  }

  const good = await insert("good", { body: "Complete." }, editor.id)
  const incomplete = await insert("incomplete", {}, editor.id)
  const authors = await insert("authors-own", { body: "Mine." }, author.id)

  const hooks = createHooks(() => {})
  const handle = router(...entryRoutes(db, hooks))
  const call = (path: string, token: string, init: RequestInit = {}) =>
    handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }),
    )

  const editorToken = (await issueSession(db, editor, { ip: "127.0.0.1", userAgent: "tests" })).token
  const authorToken = (await issueSession(db, author, { ip: "127.0.0.1", userAgent: "tests" })).token

  return { db, call, good, incomplete, authors, editor: editorToken, author: authorToken }
}

test("bulk publish validates each entry and reports per-entry outcomes", async () => {
  const { db, call, good, incomplete, editor } = await setup()

  const response = await call("/entries/bulk", editor, {
    method: "POST",
    body: JSON.stringify({ ids: [good, incomplete], action: "publish" }),
  })
  expect(response.status).toBe(200)

  const body = (await response.json()) as {
    data: { id: string; ok: boolean; code?: string }[]
    meta: { changed: number; failed: number }
  }

  // Partial success is the normal case, not an error.
  expect(body.meta.changed).toBe(1)
  expect(body.meta.failed).toBe(1)

  const byId = new Map(body.data.map(result => [result.id, result]))
  expect(byId.get(good)?.ok).toBe(true)
  expect(byId.get(incomplete)?.ok).toBe(false)
  // The same revalidation the single-entry publish route applies.
  expect(byId.get(incomplete)?.code).toBe("VALIDATION_FAILED")

  const published = await db.one<{ status: string }>(
    from(entries)
      .select("status")
      .where(q => q("id").equals(good)),
  )
  expect(published?.status).toBe("published")

  const stillDraft = await db.one<{ status: string }>(
    from(entries)
      .select("status")
      .where(q => q("id").equals(incomplete)),
  )
  expect(stillDraft?.status).toBe("draft")

  await db.close()
})

test("bulk cannot be used to get around per-entry permissions", async () => {
  const { db, call, good, authors, author } = await setup()

  // An author may not publish at all.
  const publishing = await call("/entries/bulk", author, {
    method: "POST",
    body: JSON.stringify({ ids: [authors], action: "publish" }),
  })
  const publishBody = (await publishing.json()) as { data: { ok: boolean; code?: string }[] }
  expect(publishBody.data[0]?.ok).toBe(false)
  expect(publishBody.data[0]?.code).toBe("DENIED")

  // And may only touch their own entries.
  const archiving = await call("/entries/bulk", author, {
    method: "POST",
    body: JSON.stringify({ ids: [authors, good], action: "archive" }),
  })
  const archiveBody = (await archiving.json()) as { data: { id: string; ok: boolean; code?: string }[] }
  const byId = new Map(archiveBody.data.map(result => [result.id, result]))
  expect(byId.get(authors)?.ok).toBe(true)
  expect(byId.get(good)?.ok).toBe(false)
  expect(byId.get(good)?.code).toBe("NOT_YOURS")

  await db.close()
})

test("bulk input is bounded and validated", async () => {
  const { db, call, good, editor } = await setup()

  const bad = (payload: unknown) => call("/entries/bulk", editor, { method: "POST", body: JSON.stringify(payload) })

  expect((await bad({ ids: [], action: "publish" })).status).toBe(400)
  expect((await bad({ ids: [good], action: "obliterate" })).status).toBe(400)
  expect((await bad({ ids: "not-an-array", action: "publish" })).status).toBe(400)
  expect((await bad({ ids: Array.from({ length: 201 }, () => good), action: "publish" })).status).toBe(400)
  expect((await bad({ ids: [good], action: "publish", at: "not a date" })).status).toBe(400)

  // A missing entry is one row's failure, not a rejected request.
  const missing = await bad({ ids: ["00000000-0000-0000-0000-000000000000"], action: "archive" })
  expect(missing.status).toBe(200)
  const body = (await missing.json()) as { data: { ok: boolean; code?: string }[] }
  expect(body.data[0]?.code).toBe("NOT_FOUND")

  await db.close()
})

test("duplicating an entry makes a draft copy credited to whoever copied it", async () => {
  const { db, call, good, author } = await setup()

  // Publish state must not carry over, so start from a published entry.
  await db.execute(
    from(entries)
      .update({ status: "published", published_at: now() })
      .where(q => q("id").equals(good)),
  )

  const response = await call(`/entries/${good}/duplicate`, author, { method: "POST" })
  expect(response.status).toBe(201)

  const copy = (await response.json()) as any
  expect(copy.id).not.toBe(good)
  expect(copy.title).toBe("good (copy)")
  // Slug is made unique rather than colliding with the original.
  expect(copy.slug).toBe("good-copy")
  expect(copy.status).toBe("draft")
  expect(copy.publishedAt).toBeNull()
  // Credited to the copier, not the original author.
  expect(copy.data.body).toBe("Complete.")

  // Copying twice does not collide either.
  const second = await call(`/entries/${good}/duplicate`, author, { method: "POST" })
  expect(((await second.json()) as any).slug).toBe("good-copy-2")

  await db.close()
})
