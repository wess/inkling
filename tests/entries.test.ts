import { expect, test } from "bun:test"
import { connect, from } from "@atlas/db"
import { router } from "@atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { entryRoutes, publishDue } from "../src/entries/index.ts"
import { id } from "../src/ids/index.ts"
import { encode } from "../src/json/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { contentTypes, entries, media, revisions } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const user = await createUser(db, {
    email: "editor@example.com",
    name: "Editor",
    password: "a secure password",
    role: "editor",
  })
  const session = await issueSession(db, user, { ip: "127.0.0.1", userAgent: "tests" })
  const typeId = id()
  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "article",
      label: "Article",
      plural_label: "Articles",
      description: null,
      kind: "collection",
      fields: encode([{ key: "summary", type: "text", label: "Summary" }]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )
  const hooks = createHooks(() => {})
  const handle = router(...entryRoutes(db, hooks))
  const call = (method: string, path: string, body?: unknown) =>
    handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: `Bearer ${session.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )

  return { db, typeId, hooks, call }
}

test("publishing rejects bad schedules and bypassing the publish action", async () => {
  const { db, call } = await setup()
  expect(
    (await call("POST", "/types/article/entries", { title: "Bad locale", locale: "not a locale", data: {} })).status,
  ).toBe(400)
  const created = await call("POST", "/types/article/entries", { title: "First", data: { summary: "Hello" } })
  expect(created.status).toBe(201)
  const entry = (await created.json()) as { id: string }

  expect((await call("POST", `/entries/${entry.id}/publish?at=not-a-date`)).status).toBe(400)
  expect((await call("POST", `/entries/${entry.id}/status`, { status: "published" })).status).toBe(400)

  const stored = await db.one<{ status: string }>(
    from(entries)
      .select("status")
      .where(q => q("id").equals(entry.id)),
  )
  expect(stored?.status).toBe("draft")

  const published = await call("POST", `/entries/${entry.id}/publish`)
  expect(published.status).toBe(200)
  expect(((await published.json()) as { status: string }).status).toBe("published")
  await db.close()
})

test("publishing and revision restore validate against the current content model", async () => {
  const { db, typeId, call } = await setup()
  const created = await call("POST", "/types/article/entries", { title: "Old article", data: {} })
  const entry = (await created.json()) as { id: string }

  await db.execute(
    from(contentTypes)
      .update({ fields: encode([{ key: "summary", type: "text", label: "Summary", required: true }]) })
      .where(q => q("id").equals(typeId)),
  )
  expect((await call("POST", `/entries/${entry.id}/publish`)).status).toBe(400)

  await db.execute(
    from(contentTypes)
      .update({ fields: encode([{ key: "summary", type: "text", label: "Summary" }]) })
      .where(q => q("id").equals(typeId)),
  )
  await call("PUT", `/entries/${entry.id}`, { title: "New article", data: { summary: "Complete" } })
  const revision = await db.one<{ id: string }>(
    from(revisions)
      .select("id")
      .where(q => q("entry_id").equals(entry.id))
      .orderBy("created_at", "DESC"),
  )

  await db.execute(
    from(contentTypes)
      .update({ fields: encode([{ key: "summary", type: "text", label: "Summary", required: true }]) })
      .where(q => q("id").equals(typeId)),
  )
  expect((await call("POST", `/revisions/${revision?.id}/restore`)).status).toBe(400)
  await db.close()
})

test("entry relations must point to available media and the declared content type", async () => {
  const { db, typeId, call } = await setup()
  const timestamp = now()
  const personTypeId = id()
  const pageTypeId = id()
  const personId = id()
  const pageId = id()
  const mediaId = id()

  await db.execute(
    from(contentTypes)
      .update({
        fields: encode([
          { key: "photo", type: "media", label: "Photo" },
          { key: "author", type: "reference", label: "Author", of: "person" },
        ]),
      })
      .where(q => q("id").equals(typeId)),
  )
  for (const definition of [
    { id: personTypeId, name: "person", label: "Person" },
    { id: pageTypeId, name: "page", label: "Page" },
  ]) {
    await db.execute(
      from(contentTypes).insert({
        id: definition.id,
        name: definition.name,
        label: definition.label,
        plural_label: `${definition.label}s`,
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
  }
  for (const definition of [
    { id: personId, typeId: personTypeId, slug: "person" },
    { id: pageId, typeId: pageTypeId, slug: "page" },
  ]) {
    await db.execute(
      from(entries).insert({
        id: definition.id,
        content_type_id: definition.typeId,
        slug: definition.slug,
        title: definition.slug,
        data: encode({}),
        status: "draft",
        locale: "en",
        author_id: null,
        sort_order: 0,
        published_at: null,
        scheduled_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
      }),
    )
  }
  await db.execute(
    from(media).insert({
      id: mediaId,
      filename: "portrait.png",
      storage_key: "test/portrait.png",
      url: "/media/file/test/portrait.png",
      mime: "image/png",
      size: 10,
      width: 1,
      height: 1,
      alt: null,
      caption: null,
      folder: null,
      uploaded_by: null,
      created_at: timestamp,
      deleted_at: null,
    }),
  )

  expect(
    (
      await call("POST", "/types/article/entries", {
        title: "Missing media",
        data: { photo: "missing", author: personId },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call("POST", "/types/article/entries", {
        title: "Wrong author type",
        data: { photo: mediaId, author: pageId },
      })
    ).status,
  ).toBe(400)

  const valid = await call("POST", "/types/article/entries", {
    title: "Valid relations",
    data: { photo: mediaId, author: personId },
  })
  expect(valid.status).toBe(201)
  const article = (await valid.json()) as { id: string }

  expect((await call("DELETE", `/entries/${personId}`)).status).toBe(409)
  expect(
    (
      await call("PUT", `/entries/${article.id}`, {
        data: { photo: mediaId, author: null },
      })
    ).status,
  ).toBe(200)
  expect((await call("DELETE", `/entries/${personId}`)).status).toBe(200)

  await db.execute(
    from(media)
      .update({ deleted_at: now() })
      .where(q => q("id").equals(mediaId)),
  )
  expect((await call("POST", `/entries/${article.id}/publish`)).status).toBe(400)
  await db.close()
})

test("competing scheduled sweeps publish and notify exactly once", async () => {
  const { db, typeId, hooks } = await setup()
  const timestamp = now()
  const entryId = id()
  await db.execute(
    from(entries).insert({
      id: entryId,
      content_type_id: typeId,
      slug: "scheduled",
      title: "Scheduled",
      data: encode({ summary: "Ready" }),
      status: "scheduled",
      locale: "en",
      author_id: null,
      sort_order: 0,
      published_at: null,
      scheduled_at: new Date(Date.now() - 1_000).toISOString(),
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
    }),
  )

  let notifications = 0
  hooks.on("entry.afterPublish", "test", () => {
    notifications += 1
  })
  const counts = await Promise.all([publishDue(db, hooks), publishDue(db, hooks)])

  expect(counts[0] + counts[1]).toBe(1)
  expect(notifications).toBe(1)
  expect(
    await db.one<{ status: string }>(
      from(entries)
        .select("status")
        .where(q => q("id").equals(entryId)),
    ),
  ).toMatchObject({ status: "published" })
  await db.close()
})

test("scheduled publishing moves content that no longer validates into review", async () => {
  const { db, typeId, hooks } = await setup()
  const timestamp = now()
  const entryId = id()
  await db.execute(
    from(entries).insert({
      id: entryId,
      content_type_id: typeId,
      slug: "scheduled-invalid",
      title: "Scheduled invalid",
      data: encode({}),
      status: "scheduled",
      locale: "en",
      author_id: null,
      sort_order: 0,
      published_at: null,
      scheduled_at: new Date(Date.now() - 1_000).toISOString(),
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
    }),
  )
  await db.execute(
    from(contentTypes)
      .update({ fields: encode([{ key: "summary", type: "text", label: "Summary", required: true }]) })
      .where(q => q("id").equals(typeId)),
  )

  expect(await publishDue(db, hooks)).toBe(0)
  expect(
    await db.one<{ status: string; scheduled_at: string | null }>(
      from(entries)
        .select("status", "scheduled_at")
        .where(q => q("id").equals(entryId)),
    ),
  ).toMatchObject({ status: "review", scheduled_at: null })
  await db.close()
})

test("an editor may reassign a byline; an author may not", async () => {
  const { db, typeId, call } = await setup()

  const writer = await createUser(db, {
    email: "writer@example.com",
    name: "Writer",
    password: "another secure password",
    role: "author",
  })

  const created = (await (await call("POST", `/types/article/entries`, { title: "Draft" })).json()) as any
  expect(created.authorId).not.toBe(writer.id)

  // An editor hands the credit to the person who actually wrote it.
  const reassigned = (await (await call("PUT", `/entries/${created.id}`, { authorId: writer.id })).json()) as any
  expect(reassigned.authorId).toBe(writer.id)

  // An unrelated id is refused rather than silently stored.
  expect((await call("PUT", `/entries/${created.id}`, { authorId: id() })).status).toBe(400)

  // Omitting the field leaves the credit alone.
  const renamed = (await (await call("PUT", `/entries/${created.id}`, { title: "Draft two" })).json()) as any
  expect(renamed.authorId).toBe(writer.id)

  // The author who now owns it can edit it, but cannot move the credit away.
  const session = await issueSession(db, writer, { ip: "127.0.0.1", userAgent: "tests" })
  const handle = router(
    ...entryRoutes(
      db,
      createHooks(() => {}),
    ),
  )
  const asWriter = (body: unknown) =>
    handle(
      new Request(`http://localhost/entries/${created.id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )

  expect((await asWriter({ title: "Mine now" })).status).toBe(200)
  expect((await asWriter({ authorId: null })).status).toBe(403)

  expect(typeId).toBeTruthy()
  await db.close()
})
