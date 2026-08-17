import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { id } from "../src/ids/index.ts"
import { encode } from "../src/json/index.ts"
import { up } from "../src/migrate/index.ts"
import { mintPreviewToken, previewPublicRoutes, previewRoutes, readPreviewToken } from "../src/preview/index.ts"
import { contentTypes, entries, media as mediaTable } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

// A preview link is unpublished content reachable without an account, so the
// interesting assertions are all about what bounds it: one entry, signed, brief.

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

  const mediaId = id()
  await db.execute(
    from(mediaTable).insert({
      id: mediaId,
      filename: "hero.png",
      storage_key: "2026/07/deadbeefdeadbeef/hero.png",
      url: "/media/file/2026/07/deadbeefdeadbeef/hero.png",
      mime: "image/png",
      size: 10,
      width: 1200,
      height: 630,
      alt: "Hero",
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
      name: "article",
      label: "Article",
      plural_label: "Articles",
      description: null,
      kind: "collection",
      preview_url: "/blog/{slug}",
      fields: encode([
        { key: "body", type: "textarea", label: "Body" },
        { key: "hero", type: "media", label: "Hero" },
      ]),
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

  const draftId = id()
  await db.execute(
    from(entries).insert({
      id: draftId,
      content_type_id: typeId,
      slug: "unreleased",
      title: "Unreleased",
      data: encode({ body: "Still being written.", hero: mediaId }),
      status: "draft",
      locale: "en",
      author_id: editor.id,
      sort_order: 0,
      published_at: null,
      scheduled_at: null,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }),
  )

  const editorSession = await issueSession(db, editor, { ip: "127.0.0.1", userAgent: "tests" })
  const authorSession = await issueSession(db, author, { ip: "127.0.0.1", userAgent: "tests" })

  const handle = router(...previewRoutes(db), ...previewPublicRoutes(db))
  const call = (path: string, init: RequestInit = {}, token?: string) =>
    handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : {},
      }),
    )

  return { db, call, draftId, editor: editorSession.token, author: authorSession.token }
}

test("a preview token names one entry and is rejected once tampered with or expired", async () => {
  const minted = await mintPreviewToken("entry-abc")
  const claim = await readPreviewToken(minted.token)
  expect(claim?.entryId).toBe("entry-abc")

  // Signature covers the payload, so re-pointing it at another entry fails.
  const [, signature] = minted.token.split(".")
  const forgedPayload = btoa(JSON.stringify({ entryId: "someone-elses", expiresAt: Date.now() + 60_000 }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  expect(await readPreviewToken(`${forgedPayload}.${signature}`)).toBeNull()

  expect(await readPreviewToken("garbage")).toBeNull()
  expect(await readPreviewToken("")).toBeNull()

  // Expiry is inside the signed payload, so it can't be extended either.
  const stale = await mintPreviewToken("entry-abc", -1)
  expect(await readPreviewToken(stale.token)).toBeNull()
})

test("a preview link returns the draft, expands its media, and refuses to be indexed", async () => {
  const { db, call, draftId, editor } = await setup()

  const issued = await call(`/entries/${draftId}/preview`, { method: "POST" }, editor)
  expect(issued.status).toBe(201)
  const body = (await issued.json()) as { token: string; url: string; siteUrl: string | null }

  // The type declares a template, so the admin gets a link to the real site too.
  expect(body.siteUrl).toContain("/blog/unreleased")
  expect(body.siteUrl).toContain("preview=")

  const viewed = await call(`/preview/${body.token}`)
  expect(viewed.status).toBe(200)
  expect(viewed.headers.get("x-robots-tag")).toBe("noindex, nofollow")
  expect(viewed.headers.get("cache-control")).toBe("no-store")

  const payload = (await viewed.json()) as any
  // The point of the whole feature: a draft is readable through this door.
  expect(payload.data.status).toBe("draft")
  expect(payload.data.title).toBe("Unreleased")
  expect(payload.meta.preview).toBe(true)
  // Media is expanded so the preview renders, matching the delivery API.
  expect(payload.data.data.hero).toMatchObject({ alt: "Hero", width: 1200 })

  await db.close()
})

test("an unsigned or expired preview link gets nothing", async () => {
  const { db, call, draftId } = await setup()

  expect((await call("/preview/not-a-token")).status).toBe(401)

  // Both halves are base64url, and `atob` raises on anything outside that
  // alphabet — which made a token nobody could mistake for real answer 500
  // instead of "this link is invalid".
  for (const junk of ["@@@.@@@", "a.@", `${"x".repeat(40)}.!!!`]) {
    expect((await call(`/preview/${encodeURIComponent(junk)}`)).status).toBe(401)
  }

  const expired = await mintPreviewToken(draftId, -1)
  expect((await call(`/preview/${expired.token}`)).status).toBe(401)

  await db.close()
})

test("an author cannot share a preview of someone else's entry", async () => {
  const { db, call, draftId, author, editor } = await setup()

  // The draft belongs to the editor.
  expect((await call(`/entries/${draftId}/preview`, { method: "POST" }, author)).status).toBe(400)
  expect((await call(`/entries/${draftId}/preview`, { method: "POST" }, editor)).status).toBe(201)

  await db.close()
})
