import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { id } from "../src/ids/index.ts"
import { apiKeyRoutes } from "../src/keys/index.ts"
import { up } from "../src/migrate/index.ts"
import { contentTypes } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

test("API keys reject invalid scopes and expiration times", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const owner = await createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    password: "a secure password",
    role: "owner",
  })
  const session = await issueSession(db, owner, { ip: "127.0.0.1", userAgent: "tests" })
  await db.execute(
    from(contentTypes).insert({
      id: id(),
      name: "article",
      label: "Article",
      plural_label: "Articles",
      description: null,
      kind: "collection",
      preview_url: null,
      fields: "[]",
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )
  const handle = router(...apiKeyRoutes(db))
  const create = (body: unknown) =>
    handle(
      new Request("http://localhost/keys", {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )

  expect((await create({ name: "Bad scope", scopes: ["missing"] })).status).toBe(400)
  expect((await create({ name: "Bad date", expiresAt: "tomorrow" })).status).toBe(400)
  expect((await create({ name: "Past", expiresAt: new Date(Date.now() - 1_000).toISOString() })).status).toBe(400)
  const valid = await create({
    name: "Website",
    scopes: ["article", "article"],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  })
  expect(valid.status).toBe(201)
  expect((await valid.json()) as { scopes: string[] }).toMatchObject({ scopes: ["article"] })
  await db.close()
})
