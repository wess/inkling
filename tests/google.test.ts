import { afterEach, expect, test } from "bun:test"
import { connect } from "atlas/db"
import { summarize as summarizeAds } from "../plugins/google/ads.ts"
import {
  measurementIdFor,
  properties,
  readableDay,
  summarize as summarizeAnalytics,
} from "../plugins/google/analytics.ts"
import { detail } from "../plugins/google/api.ts"
import type { Settings } from "../plugins/google/config.ts"
import { digits, scopesFor } from "../plugins/google/config.ts"
import type { State } from "../plugins/google/guide.ts"
import { build as buildGuide } from "../plugins/google/guide.ts"
import { complaints, tagFor } from "../plugins/google/tag.ts"
import { up } from "../src/migrate/index.ts"
import type { PluginSetting } from "../src/plugins/define.ts"
import { maskSecrets, readPluginSetting, writePluginSettings } from "../src/plugins/settings.ts"

const settings = (patch: Partial<Settings> = {}): Settings => ({
  measurementId: "",
  containerId: "",
  adsConversionId: "",
  clientId: "",
  clientSecret: "",
  propertyId: "",
  adsCustomerId: "",
  adsLoginCustomerId: "",
  adsDeveloperToken: "",
  adsApiVersion: "v21",
  ...patch,
})

const original = globalThis.fetch

afterEach(() => {
  globalThis.fetch = original
})

const stub = (routes: Record<string, () => Response>) => {
  globalThis.fetch = (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const match = Object.keys(routes).find(key => url.includes(key))
    if (!match) throw new Error(`unstubbed request: ${url}`)
    return routes[match]?.()
  }) as typeof fetch
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// --------------------------------------------------------------------- the tag

test("a measurement id on its own produces a working snippet", () => {
  const tag = tagFor(settings({ measurementId: "G-ABCD1234" }))

  expect(tag.kind).toBe("gtag")
  expect(tag.head).toContain("googletagmanager.com/gtag/js?id=G-ABCD1234")
  expect(tag.head).toContain("gtag('config', 'G-ABCD1234')")
  // Nothing goes after <body> for the gtag version, and claiming otherwise
  // sends someone looking for a second snippet that does not exist.
  expect(tag.body).toBe("")
})

test("an ads conversion id rides along in the same snippet", () => {
  const tag = tagFor(settings({ measurementId: "G-ABCD1234", adsConversionId: "AW-123456789" }))

  expect(tag.ids).toEqual(["G-ABCD1234", "AW-123456789"])
  expect(tag.head).toContain("gtag('config', 'G-ABCD1234')")
  expect(tag.head).toContain("gtag('config', 'AW-123456789')")
  // The script tag loads once, against the first id.
  expect(tag.head.match(/gtag\/js\?id=/g)?.length).toBe(1)
})

test("a tag manager container is served alone, because both is double counting", () => {
  const tag = tagFor(settings({ measurementId: "G-ABCD1234", containerId: "GTM-ABCD123" }))

  expect(tag.kind).toBe("gtm")
  expect(tag.head).toContain("GTM-ABCD123")
  expect(tag.head).not.toContain("G-ABCD1234")
  expect(tag.body).toContain("ns.html?id=GTM-ABCD123")
})

test("nothing configured is not a broken snippet, it is no snippet", () => {
  expect(tagFor(settings()).kind).toBe("none")
  expect(tagFor(settings()).head).toBe("")
})

test("a look-alike id is named rather than called invalid", () => {
  const dead = complaints(settings({ measurementId: "UA-12345-1" }))
  expect(dead[0]).toContain("UA-")
  expect(dead[0]).toContain("2023")

  const both = complaints(settings({ measurementId: "G-ABCD1234", containerId: "GTM-ABCD123" }))
  expect(both.some(line => line.includes("double"))).toBe(true)

  expect(complaints(settings({ measurementId: "G-ABCD1234" }))).toEqual([])
})

test("ids are reduced to what the api wants, not rejected", () => {
  // Both of these are what Google's own screens put on a clipboard.
  expect(digits("123-456-7890")).toBe("1234567890")
  expect(digits("properties/456789")).toBe("456789")
})

test("the ads permission is only requested once there is a token to use it with", () => {
  expect(scopesFor(settings())).not.toContain("https://www.googleapis.com/auth/adwords")
  expect(scopesFor(settings({ adsDeveloperToken: "abc" }))).toContain("https://www.googleapis.com/auth/adwords")
})

// ------------------------------------------------------------------- the guide

const guideState = (patch: Partial<State> = {}): State => ({
  settings: settings(),
  tag: tagFor(settings()),
  redirectUri: "https://example.com/ext/google/callback",
  connected: null,
  adsGranted: false,
  properties: { options: [], error: null },
  adsAccounts: { options: [], error: null },
  ...patch,
})

test("measuring the site is a part of its own, and needs nothing connected", () => {
  const guide = buildGuide(guideState())
  const measuring = guide.parts[0]

  expect(measuring?.title).toBe("Measure your site")
  expect(measuring?.optional).toBeUndefined()
  // The whole argument of the plugin: no step in the cheap half asks for
  // anything from the expensive one. The part's summary is allowed to name a
  // Cloud project, because it is there to say you do not need one.
  const steps = JSON.stringify(measuring?.steps)
  expect(steps).not.toContain("Cloud")
  expect(steps).not.toContain("OAuth")
  expect(steps).not.toContain("developer token")
  expect(measuring?.steps.some(step => step.connect)).toBe(false)

  expect(guide.parts.slice(1).every(part => part.optional)).toBe(true)
})

test("a step ticks itself off the value it asked for", () => {
  const before = buildGuide(guideState())
  const measurement = before.parts[0]?.steps.find(step => step.input?.endpoint.endsWith("measurementId"))
  expect(measurement?.done).toBe(false)

  const after = buildGuide(guideState({ settings: settings({ measurementId: "G-ABCD1234" }) }))
  expect(after.parts[0]?.steps.find(step => step.input?.endpoint.endsWith("measurementId"))?.done).toBe(true)
})

test("the redirect uri is offered to copy on the step that asks for it", () => {
  const guide = buildGuide(guideState())
  const client = guide.parts[1]?.steps.find(step => step.input?.endpoint.endsWith("clientId"))

  expect(client?.copy).toBe("https://example.com/ext/google/callback")
})

test("google's own words replace an empty list, so 'none' and 'switched off' are not the same screen", () => {
  const guide = buildGuide(
    guideState({ properties: { options: [], error: "Google Analytics Data API has not been used in project 5." } }),
  )
  const choose = guide.parts[1]?.steps.find(step => step.choices?.endpoint.endsWith("propertyId"))

  expect(choose?.choices?.empty).toContain("has not been used")
})

test("the tag snippet appears in the guide once there is one", () => {
  const configured = settings({ measurementId: "G-ABCD1234" })
  const guide = buildGuide(guideState({ settings: configured, tag: tagFor(configured) }))
  const paste = guide.parts[0]?.steps.find(step => step.title.includes("snippet"))

  expect(paste?.copy).toContain("G-ABCD1234")
})

// ------------------------------------------------------------------- reporting

test("a ga4 report becomes tiles a person can read", async () => {
  stub({
    ":runReport": () =>
      json({
        rows: [
          {
            dimensionValues: [{ value: "20260801" }],
            metricValues: [{ value: "10" }, { value: "12" }, { value: "30" }],
          },
          { dimensionValues: [{ value: "20260802" }], metricValues: [{ value: "5" }, { value: "6" }, { value: "18" }] },
        ],
        totals: [{ metricValues: [{ value: "15" }, { value: "18" }, { value: "48" }] }],
      }),
  })

  const stats = await summarizeAnalytics("123456", "token", 30)

  expect(stats.tiles[0]).toEqual({ label: "People", value: "15", hint: "over the last 30 days" })
  expect(stats.tiles[1]?.value).toBe("18")
  // 48 views over 18 visits.
  expect(stats.tiles[3]?.value).toBe("2.7")
  expect(stats.series?.points[0]).toEqual({ label: "01/8", value: 10 })
})

test("a compact ga4 date becomes something readable on an axis", () => {
  expect(readableDay("20260827")).toBe("27/8")
  expect(readableDay("total")).toBe("total")
})

test("properties are listed with the account they belong to", async () => {
  stub({
    accountSummaries: () =>
      json({
        accountSummaries: [
          {
            displayName: "Wess Cope",
            propertySummaries: [
              { property: "properties/111", displayName: "wess.io" },
              { property: "properties/222", displayName: "inkling" },
            ],
          },
        ],
      }),
  })

  const found = await properties("token")
  expect(found).toEqual([
    { id: "111", name: "wess.io", account: "Wess Cope" },
    { id: "222", name: "inkling", account: "Wess Cope" },
  ])
})

test("a property's measurement id is read off its web stream, skipping app streams", async () => {
  stub({
    dataStreams: () =>
      json({
        dataStreams: [
          { name: "properties/1/dataStreams/9", androidAppStreamData: { packageName: "io.wess" } },
          { name: "properties/1/dataStreams/8", webStreamData: { measurementId: "G-ZZZZ9999" } },
        ],
      }),
  })

  expect(await measurementIdFor("1", "token")).toBe("G-ZZZZ9999")
})

test("ads spend is converted out of micros and priced in the account's currency", async () => {
  stub({
    ":searchStream": () =>
      json([
        {
          results: [
            {
              customer: { currencyCode: "USD" },
              metrics: { costMicros: "12500000", clicks: "50", impressions: "4000", conversions: 5 },
            },
          ],
        },
      ]),
  })

  const stats = await summarizeAds("token", {
    version: "v21",
    customerId: "1234567890",
    developerToken: "dev",
    loginCustomerId: "",
    days: 30,
  })

  expect(stats.tiles[0]?.value).toBe("$12.50")
  expect(stats.tiles[1]?.value).toBe("50")
  // $12.50 over 50 clicks.
  expect(stats.tiles[3]?.value).toBe("$0.25")
  expect(stats.tiles[5]?.value).toBe("$2.50")
})

test("google's deepest error message is the one that survives", () => {
  const body = JSON.stringify({
    error: {
      code: 403,
      message: "Request had insufficient authentication scopes.",
      details: [{ errors: [{ message: "The caller does not have permission on property 12345." }] }],
    },
  })

  expect(detail(body)).toBe("The caller does not have permission on property 12345.")
  expect(detail("not json at all")).toBe("not json at all")
})

// ------------------------------------------------------- secret plugin settings

const declared: PluginSetting[] = [
  { key: "measurementId", label: "Measurement ID", type: "text" },
  { key: "clientSecret", label: "Client secret", type: "secret" },
]

const plugin = { name: "google", settings: declared }

const db = async () => {
  const connection = connect({ driver: "sqlite", path: ":memory:" })
  await up(connection, "./migrations")
  return connection
}

test("a secret setting is sealed on the way in and only ever four characters on the way out", async () => {
  const connection = await db()
  await writePluginSettings(connection, plugin, { measurementId: "G-ABCD1234", clientSecret: "GOCSPX-supersecret" })

  // The plugin reads what it wrote.
  expect(await readPluginSetting(connection, plugin, "clientSecret", "")).toBe("GOCSPX-supersecret")
  expect(await readPluginSetting(connection, plugin, "measurementId", "")).toBe("G-ABCD1234")

  // Nothing else does. Both the API and the assistant read through this.
  const shown = maskSecrets(declared, {
    measurementId: "G-ABCD1234",
    clientSecret: await readRaw(connection, "clientSecret"),
  })
  expect(shown.clientSecret).toBe("••••cret")
  expect(shown.measurementId).toBe("G-ABCD1234")
  expect(JSON.stringify(shown)).not.toContain("supersecret")
})

const readRaw = async (connection: Awaited<ReturnType<typeof db>>, key: string) => {
  const { readScope } = await import("../src/settings/index.ts")
  return (await readScope(connection, "google"))[key]
}

test("saving a form that never showed the secret does not overwrite it", async () => {
  const connection = await db()
  await writePluginSettings(connection, plugin, { clientSecret: "GOCSPX-original" })

  // What the admin sends back when somebody changed a different field: the
  // mask it was given, or an untouched empty box.
  await writePluginSettings(connection, plugin, { clientSecret: "••••inal", measurementId: "G-NEW" })
  await writePluginSettings(connection, plugin, { clientSecret: "" })

  expect(await readPluginSetting(connection, plugin, "clientSecret", "")).toBe("GOCSPX-original")
  expect(await readPluginSetting(connection, plugin, "measurementId", "")).toBe("G-NEW")
})

test("clearing a secret takes an explicit null, and works", async () => {
  const connection = await db()
  await writePluginSettings(connection, plugin, { clientSecret: "GOCSPX-original" })
  await writePluginSettings(connection, plugin, { clientSecret: null })

  expect(await readPluginSetting(connection, plugin, "clientSecret", "")).toBe("")
  expect(maskSecrets(declared, { clientSecret: await readRaw(connection, "clientSecret") }).clientSecret).toBe("")
})

// ------------------------------------------------------------- the real routes
//
// The plugin loaded off disk, enabled through the real registry, and driven
// through the same /ext dispatch a browser hits. Everything above is a unit;
// this is the one that would have caught a route mounted at the wrong path or a
// panel endpoint that does not exist.

const site = async () => {
  const connection = connect({ driver: "sqlite", path: ":memory:" })
  await up(connection, "./migrations")

  const { createHooks } = await import("../src/plugins/hooks.ts")
  const { createRegistry } = await import("../src/plugins/index.ts")
  const { pluginDispatch } = await import("../src/plugins/routes.ts")
  const { issueSession } = await import("../src/auth/index.ts")
  const { createUser } = await import("../src/users/index.ts")
  const { ensureNamedKey } = await import("../src/keys/index.ts")
  const { router } = await import("atlas/server")

  const hooks = createHooks(() => {})
  const registry = await createRegistry(connection, hooks, "./plugins")
  await registry.enable("google")

  const user = await createUser(connection, {
    email: "admin@example.com",
    name: "Tester",
    password: "a secure password",
    role: "admin",
  })
  const session = await issueSession(connection, user, { ip: "127.0.0.1", userAgent: "tests" })
  const deliveryKey = await ensureNamedKey(connection, "tests")

  const handle = router(...pluginDispatch(registry))

  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: `Bearer ${session.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )

  return { db: connection, call, deliveryKey }
}

test("the setup guide answers before anything at all is configured", async () => {
  const { db: connection, call } = await site()

  const response = await call("GET", "/ext/google/setup")
  expect(response.status).toBe(200)

  const { data } = (await response.json()) as { data: { parts: { title: string; optional?: boolean }[] } }
  expect(data.parts.map(part => part.title)).toEqual([
    "Measure your site",
    "Read the numbers inside Inkling",
    "Google Ads spend",
  ])
  // Nothing is connected and the screen is still useful, which is the point.
  expect(data.parts[0]?.optional).toBeUndefined()

  await connection.close()
})

test("a guide step saves the value it asked for, and the step then ticks", async () => {
  const { db: connection, call } = await site()

  const saved = await call("POST", "/ext/google/set/measurementId", { value: "G-ABCD1234" })
  expect(saved.status).toBe(200)

  const { data } = (await (await call("GET", "/ext/google/setup")).json()) as {
    data: { parts: { steps: { title: string; done?: boolean; copy?: string }[] }[] }
  }
  const measuring = data.parts[0]?.steps ?? []
  expect(measuring.find(step => step.title.includes("Measurement ID"))?.done).toBe(true)
  expect(measuring.find(step => step.title.includes("snippet"))?.copy).toContain("G-ABCD1234")

  await connection.close()
})

test("a setting the plugin does not declare is refused rather than written", async () => {
  const { db: connection, call } = await site()

  expect((await call("POST", "/ext/google/set/somethingElse", { value: "x" })).status).toBe(404)

  await connection.close()
})

test("the site reads its tag with a delivery key", async () => {
  const { db: connection, call, deliveryKey } = await site()
  await call("POST", "/ext/google/set/measurementId", { value: "G-ABCD1234" })

  const response = await call("GET", "/ext/google/tag", undefined, { "x-api-key": deliveryKey })
  expect(response.status).toBe(200)

  const { data } = (await response.json()) as { data: { kind: string; head: string; measurementId: string } }
  expect(data.kind).toBe("gtag")
  expect(data.measurementId).toBe("G-ABCD1234")
  expect(data.head).toContain("G-ABCD1234")

  await connection.close()
})

test("an unconnected panel explains itself instead of failing", async () => {
  const { db: connection, call } = await site()

  const traffic = (await (await call("GET", "/ext/google/analytics")).json()) as {
    data: { note: string; tiles: unknown[] }
  }
  expect(traffic.data.tiles).toEqual([])
  expect(traffic.data.note).toContain("five minutes")

  await call("POST", "/ext/google/set/measurementId", { value: "G-ABCD1234" })
  const measured = (await (await call("GET", "/ext/google/analytics")).json()) as { data: { note: string } }
  // Once the site is measured, the panel says so — the numbers exist, they are
  // just in Google's reports rather than this one.
  expect(measured.data.note).toContain("is** being measured")

  const ads = (await (await call("GET", "/ext/google/ads")).json()) as { data: { note: string } }
  expect(ads.data.note).toContain("Setup")

  await connection.close()
})

test("connecting is refused with the reason, not a dead button", async () => {
  const { db: connection, call } = await site()

  const connections = (await (await call("GET", "/ext/google/connections")).json()) as {
    data: { redirectUri: string; connections: { configured: boolean; hint: string }[] }
  }
  expect(connections.data.connections[0]?.configured).toBe(false)
  expect(connections.data.connections[0]?.hint).toContain("Setup")
  expect(connections.data.redirectUri).toContain("/ext/google/callback")

  const started = await call("POST", "/ext/google/connections/google/start")
  expect(started.status).toBe(400)
  expect(await started.text()).toContain("OAuth client ID")

  await connection.close()
})

test("a client secret set through the guide is sealed, and never comes back out", async () => {
  const { db: connection, call } = await site()
  await call("POST", "/ext/google/set/clientSecret", { value: "GOCSPX-fromtheguide" })

  const { readScope } = await import("../src/settings/index.ts")
  const stored = await readScope(connection, "google")
  expect(JSON.stringify(stored)).not.toContain("fromtheguide")

  // And the step it belongs to knows it is set without being able to read it.
  const { data } = (await (await call("GET", "/ext/google/setup")).json()) as {
    data: { parts: { steps: { title: string; done?: boolean }[] }[] }
  }
  expect(data.parts[1]?.steps.find(step => step.title.includes("client secret"))?.done).toBe(true)

  await connection.close()
})
