import { expect, test } from "bun:test"
import { connect } from "atlas/db"
import { router } from "atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { contentTypeRoutes } from "../src/contenttypes/index.ts"
import { contentVersion } from "../src/contentversion/index.ts"
import { designRoutes } from "../src/design/index.ts"
import { entryRoutes } from "../src/entries/index.ts"
import { menuRoutes } from "../src/menus/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { settingsRoutes } from "../src/settings/index.ts"
import { taxonomyRoutes } from "../src/taxonomy/index.ts"
import { createUser } from "../src/users/index.ts"

test("successful content, menu, settings, design, and taxonomy writes invalidate host caches", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const user = await createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    password: "a secure password",
    role: "owner",
  })
  const session = await issueSession(db, user, { ip: "127.0.0.1", userAgent: "tests" })
  const hooks = createHooks()
  const version = contentVersion(hooks)
  const handle = router(
    ...contentTypeRoutes(db, hooks),
    ...entryRoutes(db, hooks),
    ...menuRoutes(db, hooks),
    ...settingsRoutes(db, hooks),
    ...designRoutes(db, { buttons: { label: "Buttons", selector: ".button" } }, hooks),
    ...taxonomyRoutes(db, hooks),
  )
  const call = (method: string, path: string, body?: unknown) =>
    handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  expect(version()).toBe(0)
  expect((await call("POST", "/types", { name: "page", label: "Page", fields: [] })).status).toBe(201)
  const created = await call("POST", "/types/page/entries", { title: "Hello", data: {} })
  const entry = (await created.json()) as { id: string }
  expect(version()).toBe(2)
  await call("GET", `/entries/${entry.id}`)
  await call("PUT", "/settings", { madeUp: "Invalid" })
  expect(version()).toBe(2)
  for (const [method, path, body] of [
    ["PUT", `/entries/${entry.id}`, { title: "New title" }],
    ["POST", `/entries/${entry.id}/publish`, undefined],
    ["POST", `/entries/${entry.id}/unpublish`, undefined],
    ["DELETE", `/entries/${entry.id}`, undefined],
    ["POST", "/menus", { name: "main", label: "Main", items: [] }],
    ["PUT", "/menus/main", { label: "Primary" }],
    ["DELETE", "/menus/main", undefined],
    ["PUT", "/settings", { title: "My site" }],
    ["PUT", "/design", { changes: [{ surface: "buttons", property: "color", value: "#112233" }] }],
    ["POST", "/taxonomies", { name: "genre", label: "Genre" }],
    ["DELETE", "/taxonomies/genre", undefined],
  ] as const) {
    const previous = version()
    const response = await call(method, path, body)
    expect(response.ok).toBe(true)
    expect(version()).toBe(previous + 1)
  }
  hooks.clearPlugins()
  const previous = version()
  await call("PUT", "/settings", { title: "Still observed" })
  expect(version()).toBe(previous + 1)
  await db.close()
})
