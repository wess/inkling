import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { auditRoutes, registerContentAudit } from "../src/audit/index.ts"
import { issueSession } from "../src/auth/index.ts"
import { entryRoutes } from "../src/entries/index.ts"
import { id } from "../src/ids/index.ts"
import { encode } from "../src/json/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { contentTypes } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

test("content activity is recorded and visible to administrators", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const owner = await createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    password: "a secure password",
    role: "owner",
  })
  const session = await issueSession(db, owner, { ip: "127.0.0.1", userAgent: "tests" })
  const timestamp = now()
  await db.execute(
    from(contentTypes).insert({
      id: id(),
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
      created_at: timestamp,
      updated_at: timestamp,
    }),
  )
  const hooks = createHooks(() => {})
  registerContentAudit(db, hooks)
  const handle = router(...entryRoutes(db, hooks), ...auditRoutes(db))
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" }

  expect(
    (
      await handle(
        new Request("http://localhost/types/article/entries", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Recorded change", data: {} }),
        }),
      )
    ).status,
  ).toBe(201)
  const response = await handle(new Request("http://localhost/audit", { headers }))
  expect(response.status).toBe(200)
  expect(
    (await response.json()) as { data: { event: string; userName: string; metadata: { title: string } }[] },
  ).toMatchObject({ data: [{ event: "content.created", userName: "Owner", metadata: { title: "Recorded change" } }] })
  await db.close()
})
