import { expect, test } from "bun:test"
import { connect } from "@atlas/db"
import { router } from "@atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { contentTypeRoutes } from "../src/contenttypes/index.ts"
import { up } from "../src/migrate/index.ts"
import { createUser } from "../src/users/index.ts"

test("content models reject missing references and cannot delete referenced models", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const owner = await createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    password: "a secure password",
    role: "owner",
  })
  const session = await issueSession(db, owner, { ip: "127.0.0.1", userAgent: "tests" })
  const handle = router(...contentTypeRoutes(db))
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

  expect(
    (
      await call("POST", "/types", {
        name: "article",
        label: "Article",
        fields: [{ key: "author", type: "reference", label: "Author", of: "missing" }],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await call("POST", "/types", {
        name: "badpreview",
        label: "Bad preview",
        previewUrl: "javascript:alert(1)",
        fields: [],
      })
    ).status,
  ).toBe(400)
  expect((await call("POST", "/types", { name: "person", label: "Person", fields: [] })).status).toBe(201)
  expect(
    (
      await call("POST", "/types", {
        name: "article",
        label: "Article",
        previewUrl: "/articles/{slug}",
        fields: [{ key: "author", type: "reference", label: "Author", of: "person" }],
      })
    ).status,
  ).toBe(201)

  expect(((await (await call("GET", "/types/article")).json()) as { previewUrl: string }).previewUrl).toBe(
    "/articles/{slug}",
  )

  expect((await call("DELETE", "/types/person")).status).toBe(409)
  expect((await call("PUT", "/types/article", { fields: [] })).status).toBe(200)
  expect((await call("DELETE", "/types/person")).status).toBe(200)
  await db.close()
})
