import { expect, test } from "bun:test"
import { connect, from } from "@atlas/db"
import { router } from "@atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { media } from "../src/schema/index.ts"
import { settingsRoutes } from "../src/settings/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

test("site settings validate URLs, locales, timezones, and media references", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const owner = await createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    password: "a secure password",
    role: "owner",
  })
  const session = await issueSession(db, owner, { ip: "127.0.0.1", userAgent: "tests" })
  const handle = router(...settingsRoutes(db))
  const save = (body: unknown) =>
    handle(
      new Request("http://localhost/settings", {
        method: "PUT",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )

  expect((await save({ url: "javascript:alert(1)" })).status).toBe(400)
  expect((await save({ locale: "not a locale" })).status).toBe(400)
  expect((await save({ timezone: "Moon/Sea_of_Tranquility" })).status).toBe(400)
  expect((await save({ logoId: "missing" })).status).toBe(400)

  const mediaId = id()
  await db.execute(
    from(media).insert({
      id: mediaId,
      filename: "logo.png",
      storage_key: "test/logo.png",
      url: "/media/file/test/logo.png",
      mime: "image/png",
      size: 10,
      width: 1,
      height: 1,
      alt: null,
      caption: null,
      folder: null,
      uploaded_by: owner.id,
      created_at: now(),
      deleted_at: null,
    }),
  )
  const response = await save({
    title: "Example",
    url: "https://example.com/",
    locale: "en-US",
    timezone: "America/New_York",
    logoId: mediaId,
  })
  expect(response.status).toBe(200)
  expect((await response.json()) as { data: Record<string, unknown> }).toMatchObject({
    data: { title: "Example", url: "https://example.com", locale: "en-US", logoId: mediaId },
  })
  await db.close()
})
