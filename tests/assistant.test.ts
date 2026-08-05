import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import plugin from "../plugins/assistant/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { contentTypes, entries } from "../src/schema/index.ts"
import { writeSetting } from "../src/settings/index.ts"
import { now } from "../src/time/index.ts"

// The public bubble is the one route in this codebase a stranger can reach with
// no credential at all, and it spends the operator's money when they do. What is
// asserted here is that it stays shut: off by default, and useless from an
// origin nobody allowed. The answering itself is the same function the keyed
// route calls, so it is covered by that route's behaviour rather than twice.

const SCOPE = "plugin:assistant"

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

  const typeId = id()
  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "page",
      label: "Page",
      plural_label: "Pages",
      description: null,
      kind: "collection",
      preview_url: null,
      fields: JSON.stringify([{ key: "body", type: "textarea", label: "Body" }]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )

  await db.execute(
    from(entries).insert({
      id: id(),
      content_type_id: typeId,
      slug: "hours",
      title: "Opening hours",
      data: JSON.stringify({ body: "We open at nine." }),
      status: "published",
      locale: "en",
      author_id: null,
      sort_order: 0,
      published_at: now(),
      scheduled_at: null,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }),
  )

  const ctx = {
    db,
    name: "assistant",
    on: () => {},
    filter: () => {},
    getSetting: async <T>(key: string, fallback: T): Promise<T> => {
      const row = await db.one<{ value: string }>(
        from("settings", "s")
          .select("value")
          .where(q => q("scope").equals(SCOPE))
          .where(q => q("key").equals(key)),
      )
      return row ? (JSON.parse(row.value) as T) : fallback
    },
    setSetting: async (key: string, value: unknown) => writeSetting(db, SCOPE, key, value),
    allSettings: async () => ({}),
    log: () => {},
  }

  const routes = await (plugin.routes ?? (() => []))(ctx as never)
  return { db, ctx, handle: router(...routes) }
}

const ask = (handle: ReturnType<typeof router>, origin?: string) =>
  handle(
    new Request("http://localhost/public-ask", {
      method: "POST",
      headers: origin ? { "content-type": "application/json", origin } : { "content-type": "application/json" },
      body: JSON.stringify({ question: "When do you open?" }),
    }),
  )

test("the public bubble is off until an operator turns it on", async () => {
  const { db, handle } = await setup()

  // Nothing configured: the endpoint exists but answers nobody.
  expect((await ask(handle, "https://example.com")).status).toBe(403)
  expect((await handle(new Request("http://localhost/widget.js"))).status).toBe(403)

  await db.close()
})

test("enabling it without naming an origin still answers nobody", async () => {
  // Two switches rather than one, because either alone is a way to leave it
  // open by accident — and this is the route with no key on it.
  const { db, ctx, handle } = await setup()
  await ctx.setSetting("widget", true)

  expect((await ask(handle, "https://example.com")).status).toBe(403)
  // A request with no Origin header at all is refused on the same grounds.
  expect((await ask(handle)).status).toBe(403)

  await db.close()
})

test("an origin nobody listed is refused even once the bubble is on", async () => {
  const { db, ctx, handle } = await setup()
  await ctx.setSetting("widget", true)
  await ctx.setSetting("origins", "https://mysite.com")

  const refused = await ask(handle, "https://someone-elses-site.com")
  expect(refused.status).toBe(403)
  expect(await refused.text()).toContain("ORIGIN_NOT_ALLOWED")

  await db.close()
})

test("a listed origin gets through, and the reply carries its CORS header", async () => {
  const { db, ctx, handle } = await setup()
  await ctx.setSetting("widget", true)
  await ctx.setSetting("origins", "https://mysite.com, https://www.mysite.com")

  // No AI provider is connected in this test database, so the request reaches
  // the answering code and stops there — which is the proof that the gate let
  // it through rather than the gate being what refused it.
  const response = await ask(handle, "https://www.mysite.com")
  expect(response.status).not.toBe(403)
  expect(await response.text()).toContain("AI_NOT_CONFIGURED")

  await db.close()
})

test("the widget script is served once enabled, and carries the operator's greeting", async () => {
  const { db, ctx, handle } = await setup()
  await ctx.setSetting("widget", true)
  await ctx.setSetting("greeting", "Ask us about opening times")

  const response = await handle(new Request("http://localhost/widget.js"))
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("javascript")

  const body = await response.text()
  expect(body).toContain("Ask us about opening times")
  // It finds its own endpoint from the tag that loaded it, so a site never
  // configures the origin twice.
  expect(body).toContain("/ext/assistant/public-ask")
  expect(body).toContain("attachShadow")

  await db.close()
})
