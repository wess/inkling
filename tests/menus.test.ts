import { expect, test } from "bun:test"
import { connect } from "atlas/db"
import { router } from "atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { menuRoutes } from "../src/menus/index.ts"
import { up } from "../src/migrate/index.ts"
import { createUser } from "../src/users/index.ts"

test("menus reject unsafe URLs and excessive nesting", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const editor = await createUser(db, {
    email: "editor@example.com",
    name: "Editor",
    password: "a secure password",
    role: "editor",
  })
  const session = await issueSession(db, editor, { ip: "127.0.0.1", userAgent: "tests" })
  const handle = router(...menuRoutes(db))
  const create = (items: unknown[]) =>
    handle(
      new Request("http://localhost/menus", {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "Main", items }),
      }),
    )

  expect((await create([{ label: "Unsafe", url: "javascript:alert(1)" }])).status).toBe(400)
  expect(
    (
      await create([
        {
          label: "One",
          children: [
            {
              label: "Two",
              children: [
                { label: "Three", children: [{ label: "Four", children: [{ label: "Five", url: "/five" }] }] },
              ],
            },
          ],
        },
      ])
    ).status,
  ).toBe(400)
  expect((await create([{ label: "Shop", url: "/shop" }])).status).toBe(201)
  await db.close()
})
