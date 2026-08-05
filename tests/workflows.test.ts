import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { id } from "../src/ids/index.ts"
import { encode } from "../src/json/index.ts"
import { mediaRoutes } from "../src/media/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { contentTypes, entries, media, settings, taxonomies, terms } from "../src/schema/index.ts"
import type { StorageDriver } from "../src/storage/index.ts"
import { taxonomyRoutes } from "../src/taxonomy/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

test("authors can categorize their own entries but not someone else's", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const author = await createUser(db, {
    email: "author@example.com",
    name: "Author",
    password: "a secure password",
    role: "author",
  })
  const editor = await createUser(db, {
    email: "editor@example.com",
    name: "Editor",
    password: "a secure password",
    role: "editor",
  })
  const session = await issueSession(db, author, { ip: "127.0.0.1", userAgent: "tests" })
  const timestamp = now()
  const typeId = id()
  const taxonomyId = id()
  const termId = id()
  const ownEntry = id()
  const otherEntry = id()

  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "article",
      label: "Article",
      plural_label: "Articles",
      description: null,
      kind: "collection",
      fields: encode([]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  )
  await db.execute(
    from(taxonomies).insert({
      id: taxonomyId,
      name: "topic",
      label: "Topic",
      hierarchical: 0,
      owner_plugin: null,
      created_at: timestamp,
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
      created_at: timestamp,
    }),
  )
  for (const [entryId, authorId] of [
    [ownEntry, author.id],
    [otherEntry, editor.id],
  ]) {
    await db.execute(
      from(entries).insert({
        id: entryId,
        content_type_id: typeId,
        slug: entryId,
        title: "Article",
        data: encode({}),
        status: "draft",
        locale: "en",
        author_id: authorId,
        sort_order: 0,
        published_at: null,
        scheduled_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
      }),
    )
  }

  const handle = router(...taxonomyRoutes(db))
  const assign = (entryId: string) =>
    handle(
      new Request(`http://localhost/entries/${entryId}/terms`, {
        method: "PUT",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ termIds: [termId] }),
      }),
    )

  expect((await assign(ownEntry)).status).toBe(200)
  expect((await assign(otherEntry)).status).toBe(403)
  await db.close()
})

test("deleted media can be listed and restored without losing its blob", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const author = await createUser(db, {
    email: "author@example.com",
    name: "Author",
    password: "a secure password",
    role: "author",
  })
  const session = await issueSession(db, author, { ip: "127.0.0.1", userAgent: "tests" })
  const mediaId = id()
  const typeId = id()
  const entryId = id()
  const timestamp = now()
  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "article",
      label: "Article",
      plural_label: "Articles",
      description: null,
      kind: "collection",
      fields: encode([{ key: "photo", type: "media", label: "Photo" }]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  )
  await db.execute(
    from(media).insert({
      id: mediaId,
      filename: "photo.png",
      storage_key: "test/photo.png",
      url: "/media/file/test/photo.png",
      mime: "image/png",
      size: 10,
      width: 1,
      height: 1,
      alt: null,
      caption: null,
      folder: null,
      uploaded_by: author.id,
      created_at: timestamp,
      deleted_at: null,
    }),
  )
  await db.execute(
    from(entries).insert({
      id: entryId,
      content_type_id: typeId,
      slug: "uses-photo",
      title: "Uses photo",
      data: encode({ photo: mediaId }),
      status: "draft",
      locale: "en",
      author_id: author.id,
      sort_order: 0,
      published_at: null,
      scheduled_at: null,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
    }),
  )

  let drops = 0
  const store: StorageDriver = {
    kind: "test",
    put: async () => ({ url: "/unused" }),
    get: async () => null,
    drop: async () => {
      drops += 1
    },
  }
  const handle = router(
    ...mediaRoutes(
      db,
      store,
      createHooks(() => {}),
    ),
  )
  const call = (method: string, path: string) =>
    handle(new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${session.token}` } }))

  expect((await call("DELETE", `/media/${mediaId}`)).status).toBe(409)
  await db.execute(
    from(entries)
      .update({ data: encode({ photo: null }) })
      .where(q => q("id").equals(entryId)),
  )
  await db.execute(from(settings).insert({ scope: "site", key: "logoId", value: encode(mediaId), updated_at: now() }))
  expect((await call("DELETE", `/media/${mediaId}`)).status).toBe(409)
  await db.execute(
    from(settings)
      .where(q => q("scope").equals("site"))
      .where(q => q("key").equals("logoId"))
      .del(),
  )
  expect((await call("DELETE", `/media/${mediaId}`)).status).toBe(200)
  const trashed = (await (await call("GET", "/trash/media")).json()) as { data: { id: string }[] }
  expect(trashed.data.map(item => item.id)).toEqual([mediaId])
  expect((await call("POST", `/trash/media/${mediaId}/restore`)).status).toBe(200)
  expect((await call("GET", "/trash/media")).status).toBe(200)
  expect(drops).toBe(0)
  await db.close()
})
