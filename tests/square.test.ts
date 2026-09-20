import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { settings } from "../plugins/square/config.ts"
import { connected, current, save } from "../plugins/square/connection.ts"
import square from "../plugins/square/index.ts"
import { authRoutes } from "../src/auth/index.ts"
import { rows } from "../src/db/dialect.ts"
import { entryRoutes } from "../src/entries/index.ts"
import { ensureNamedKey } from "../src/keys/index.ts"
import { up } from "../src/migrate/index.ts"
import type { PluginContext } from "../src/plugins/define.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { createRegistry } from "../src/plugins/index.ts"
import { pluginDispatch } from "../src/plugins/routes.ts"
import { readPluginSetting, writePluginSettings } from "../src/plugins/settings.ts"
import { createUser } from "../src/users/index.ts"

import { item, location } from "./fixtures/square.ts"

const must = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing test fixture value")
  return value
}

const originalFetch = globalThis.fetch
const originalEnv = {
  SQUARE_ENVIRONMENT: Bun.env.SQUARE_ENVIRONMENT,
  SQUARE_APPLICATION_ID: Bun.env.SQUARE_APPLICATION_ID,
  SQUARE_APPLICATION_SECRET: Bun.env.SQUARE_APPLICATION_SECRET,
}
const db = connect({ driver: "sqlite", path: ":memory:" })
const hooks = createHooks(() => {})
const ctx: PluginContext = {
  db,
  name: "square",
  adminBase: "/admin",
  on: () => {},
  filter: () => {},
  log: () => {},
  allSettings: async () => ({}),
  getSetting: (key, fallback) => readPluginSetting(db, square, key, fallback),
  setSetting: (key, value) => writePluginSettings(db, square, { [key]: value }),
}
let handle: ReturnType<typeof router>
let owner = ""
let author = ""
let key = ""
let registry: Awaited<ReturnType<typeof createRegistry>>
let calls: { path: string; data: any; authorization: string | null }[] = []
const tokens = () => ({
  access_token: "test-access-secret",
  refresh_token: "test-refresh-secret",
  merchant_id: "MERCHANT",
  expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
})
let catalog = item()
let stock = "3"
const response = (data: unknown, status = 200) => Response.json(data, { status })

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin !== "https://connect.squareupsandbox.com") throw new Error("Unexpected network destination")
  const data = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
  calls.push({ path: url.pathname, data, authorization: new Headers(init?.headers).get("authorization") })
  if (url.pathname === "/oauth2/token") return response(tokens())
  if (url.pathname === "/v2/locations") return response({ locations: [location] })
  if (url.pathname === "/v2/catalog/list") return response({ objects: [catalog] })
  if (url.pathname === "/v2/catalog/batch-retrieve")
    return response({ objects: data.object_ids.includes(catalog.id) ? [catalog] : [] })
  if (url.pathname === "/v2/inventory/counts/batch-retrieve")
    return response({
      counts: [{ catalog_object_id: "VARIATION", location_id: "LOCATION", state: "IN_STOCK", quantity: stock }],
    })
  if (url.pathname === "/v2/online-checkout/payment-links")
    return response({ payment_link: { id: "LINK", order_id: "ORDER", url: "https://square.link/u/test" } })
  if (url.pathname === "/v2/orders/search") return response({ orders: [] })
  throw new Error(`Unstubbed Square endpoint ${url.pathname}`)
}) as typeof fetch

const request = (
  path: string,
  opts: { token?: string; delivery?: boolean; body?: unknown; cookie?: string; method?: string } = {},
) =>
  handle(
    new Request(`http://localhost${path}`, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.delivery ? { "x-api-key": key } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  )
const connectShop = async () => {
  await save(db, await settings(ctx), tokens())
  await ctx.setSetting("locationId", "LOCATION")
  await ctx.setSetting("checkoutEnabled", true)
}
const add = async (publish = true) => {
  const result = await request("/ext/square/setup/product", { token: owner, body: { value: "ITEM" } })
  expect(result.status).toBe(200)
  const { data } = (await result.json()) as { data: { id: string } }
  if (publish) expect((await request(`/entries/${data.id}/publish`, { token: owner, method: "POST" })).status).toBe(200)
  return data.id
}
const checkout = (id: string, patch: Record<string, unknown> = {}) =>
  request("/ext/square/checkout", {
    delivery: true,
    body: {
      idempotencyKey: "test-cart-key-123456",
      items: [{ productId: id, variationId: "VARIATION", quantity: 1 }],
      ...patch,
    },
  })

beforeAll(async () => {
  await up(db, "./migrations")
  registry = await createRegistry(db, hooks, "./plugins", "/admin")
  await registry.enable("square")
  handle = router(...authRoutes(db), ...entryRoutes(db, hooks), ...pluginDispatch(registry))
  for (const role of ["owner", "author"] as const) {
    await createUser(db, { name: role, email: `${role}@square.test`, password: "square-test-password", role })
    const result = await request("/auth/login", {
      body: { email: `${role}@square.test`, password: "square-test-password" },
    })
    const payload = (await result.json()) as { token: string }
    if (role === "owner") owner = payload.token
    else author = payload.token
  }
  key = await ensureNamedKey(db, "squaretest")
})

beforeEach(async () => {
  Bun.env.SQUARE_ENVIRONMENT = "sandbox"
  Bun.env.SQUARE_APPLICATION_ID = "test-application"
  Bun.env.SQUARE_APPLICATION_SECRET = "test-application-secret"
  await db.execute(from("square_connections").del())
  await db.execute(from("square_oauth").del())
  await db.execute(from("square_products").del())
  await db.execute(from("revisions").del())
  await db.execute(from("entries").del())
  await db.execute(from("rate_limits").del())
  await ctx.setSetting("locationId", "")
  await ctx.setSetting("checkoutEnabled", false)
  await ctx.setSetting("shippingFee", 0)
  calls = []
  stock = "3"
  catalog = item()
  globalThis.fetch = fakeFetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete Bun.env[name]
    else Bun.env[name] = value
  }
})
afterAll(async () => {
  await db.close()
})

test("Square enables Ecommerce, and private setup rejects visitors and authors", async () => {
  expect(registry.get("commerce")?.enabled).toBe(true)
  for (const path of ["setup", "connections", "orders"]) {
    expect((await request(`/ext/square/${path}`)).status).toBe(401)
    expect((await request(`/ext/square/${path}`, { token: author })).status).toBe(403)
  }
  expect((await request("/ext/square/setup", { token: owner })).status).toBe(200)
  expect(calls).toHaveLength(0)
})

test("OAuth is browser-bound, single-use, and saves encrypted tokens", async () => {
  const start = await request("/ext/square/connections/square/start", { token: owner, method: "POST" })
  expect(start.status).toBe(200)
  const { data } = (await start.json()) as { data: { url: string } }
  const consent = new URL(data.url)
  expect(consent.searchParams.get("scope")).toContain("PAYMENTS_WRITE")
  expect(consent.searchParams.has("client_secret")).toBe(false)
  const path = `/ext/square/callback?state=${encodeURIComponent(must(consent.searchParams.get("state")))}&code=test-code`
  expect((await request(path)).headers.get("location")).toContain("connected=error")
  expect(await current(db)).toBeNull()
  const cookie = must(must(start.headers.get("set-cookie")).split(";")[0])
  expect((await request(path, { cookie })).headers.get("location")).toContain("connected=ok")
  const account = await current(db)
  expect(account?.merchant_id).toBe("MERCHANT")
  expect(JSON.stringify(account)).not.toContain("test-access-secret")
  expect(JSON.stringify(account)).not.toContain("test-refresh-secret")
  expect((await request(path, { cookie })).headers.get("location")).toContain("connected=error")
  expect(calls.filter(call => call.path === "/oauth2/token")).toHaveLength(1)
  expect(await ctx.getSetting("checkoutEnabled", true)).toBe(false)
})

test("a different app cannot consume a pending OAuth connection", async () => {
  const start = await request("/ext/square/connections/square/start", { token: owner, method: "POST" })
  const { data } = (await start.json()) as { data: { url: string } }
  Bun.env.SQUARE_APPLICATION_ID = "another-application"
  const path = `/ext/square/callback?state=${encodeURIComponent(must(new URL(data.url).searchParams.get("state")))}&code=test-code`
  expect(
    (await request(path, { cookie: must(must(start.headers.get("set-cookie")).split(";")[0]) })).headers.get(
      "location",
    ),
  ).toContain("connected=error")
  expect(calls).toHaveLength(0)
})

test("catalog delivery requires a scoped key and published shop pages", async () => {
  await connectShop()
  const id = await add(false)
  expect((await request("/ext/square/products")).status).toBe(401)
  let result = await request("/ext/square/products", { delivery: true })
  expect(((await result.json()) as any).data).toHaveLength(0)
  expect((await checkout(id)).status).toBe(400)
  await request(`/entries/${id}/publish`, { token: owner, method: "POST" })
  result = await request("/ext/square/products", { delivery: true })
  const payload = (await result.json()) as any
  expect(payload.data[0].variations[0].price).toEqual({ amount: 1250, currency: "USD" })
  expect(payload.data[0].variations[0].stock).toBe(3)
  await db.execute(from("api_keys").update({ scopes: '["product"]' }))
  expect((await request("/ext/square/products", { delivery: true })).status).toBe(403)
  await db.execute(from("api_keys").update({ scopes: "[]" }))
})

test("checkout uses Square variation IDs and server shipping, never submitted prices", async () => {
  await connectShop()
  const id = await add()
  await ctx.setSetting("shippingFee", 500)
  const result = await checkout(id)
  expect(result.status).toBe(200)
  const link = must(calls.find(call => call.path === "/v2/online-checkout/payment-links"))
  expect(link.data.order.line_items).toEqual([{ catalog_object_id: "VARIATION", quantity: "1" }])
  expect(link.data.order.pricing_options.auto_apply_taxes).toBe(true)
  expect(link.data.checkout_options.shipping_fee.charge.amount).toBe(500)
  expect(link.authorization).toBe("Bearer test-access-secret")
  await checkout(id)
  const links = calls.filter(call => call.path === "/v2/online-checkout/payment-links")
  expect(must(links[0]).data.idempotency_key).toBe(must(links[1]).data.idempotency_key)
  expect((await checkout(id, { price: 1 })).status).toBe(400)
  expect(
    (await checkout(id, { items: [{ productId: id, variationId: "VARIATION", quantity: 1, price: 1 }] })).status,
  ).toBe(400)
  expect((await checkout(id, { items: [{ productId: id, variationId: "OTHER", quantity: 1 }] })).status).toBe(400)
  expect(calls.filter(call => call.path === "/v2/online-checkout/payment-links")).toHaveLength(2)
})

test("stock checks aggregate duplicate lines and reject unavailable inventory", async () => {
  await connectShop()
  const id = await add()
  const items = [
    { productId: id, variationId: "VARIATION", quantity: 2 },
    { productId: id, variationId: "VARIATION", quantity: 2 },
  ]
  expect((await checkout(id, { items })).status).toBe(400)
  stock = "0"
  expect((await checkout(id)).status).toBe(400)
  stock = "NaN"
  expect((await checkout(id)).status).toBe(400)
  expect(calls.some(call => call.path === "/v2/online-checkout/payment-links")).toBe(false)
})

test("account replacement, disconnect, pause, and archived products stop checkout", async () => {
  await connectShop()
  const id = await add()
  must(catalog.item_data).is_archived = true
  expect((await checkout(id)).status).toBe(400)
  catalog = item()
  await ctx.setSetting("checkoutEnabled", false)
  expect((await checkout(id)).status).toBe(400)
  await ctx.setSetting("checkoutEnabled", true)
  await save(db, await settings(ctx), { ...tokens(), merchant_id: "OTHER" })
  expect((await checkout(id)).status).toBe(400)
  const row = await current(db)
  expect((await request(`/ext/square/connections/${must(row).id}`, { token: owner, method: "DELETE" })).status).toBe(
    200,
  )
  expect(await current(db)).toBeNull()
  expect((await checkout(id)).status).toBe(400)
  expect(calls.some(call => call.path === "/v2/online-checkout/payment-links")).toBe(false)
})

test("expired access refreshes once across concurrent requests and honors expires_at", async () => {
  await save(db, await settings(ctx), { ...tokens(), expires_at: new Date(Date.now() - 1000).toISOString() })
  const s = await settings(ctx)
  await Promise.all([connected(db, s), connected(db, s), connected(db, s)])
  expect(calls.filter(call => call.path === "/oauth2/token")).toHaveLength(1)
  expect(Date.parse(must(await current(db)).expires_at)).toBeGreaterThan(Date.now() + 29 * 86400000)
  expect(must(calls[0]).data.grant_type).toBe("refresh_token")
})

test("Square failures fail closed without exposing upstream error bodies", async () => {
  await connectShop()
  const id = await add()
  globalThis.fetch = (async () => response({ token: "should-never-appear" }, 401)) as unknown as typeof fetch
  const result = await checkout(id)
  expect(result.status).toBe(400)
  expect(await result.text()).not.toContain("should-never-appear")
})

test("shop pages retain private provider bindings outside their editable content", async () => {
  await connectShop()
  const id = await add(false)
  const bindings = await rows<{ entry_id: string; item_id: string }>(db, from("square_products"))
  expect(bindings).toEqual([{ entry_id: id, merchant_id: "MERCHANT", environment: "sandbox", item_id: "ITEM" }] as any)
  expect(await add(false)).toBe(id)
  const guide = await request("/ext/square/setup", { token: owner })
  expect(guide.status).toBe(200)
  expect(await guide.text()).not.toContain("test-access-secret")
})
