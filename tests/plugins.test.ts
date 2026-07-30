import { expect, test } from "bun:test"
import { validatePlugin } from "../src/plugins/define.ts"
import { createHooks } from "../src/plugins/hooks.ts"

const quiet = () => {}

test("emit runs every listener and isolates failures", async () => {
  const hooks = createHooks(quiet)
  const seen: string[] = []

  hooks.on("server.ready", "a", () => {
    seen.push("a")
  })
  hooks.on("server.ready", "boom", () => {
    throw new Error("plugin exploded")
  })
  hooks.on("server.ready", "c", () => {
    seen.push("c")
  })

  await hooks.emit("server.ready", { at: "now" })
  // The throwing listener must not stop the ones after it.
  expect(seen).toEqual(["a", "c"])
})

test("filters chain in registration order", async () => {
  const hooks = createHooks(quiet)
  const payload = { payload: { n: 1 } } as any

  hooks.addFilter("delivery.entry", "double", p => ({ ...p, payload: { n: (p.payload as any).n * 2 } }))
  hooks.addFilter("delivery.entry", "addten", p => ({ ...p, payload: { n: (p.payload as any).n + 10 } }))

  const result = await hooks.filter("delivery.entry", payload)
  expect((result.payload as any).n).toBe(12)
})

// A broken filter must degrade to a no-op, not blank the payload — otherwise
// one bad plugin silently empties the delivery API.
test("a throwing filter passes its input through unchanged", async () => {
  const hooks = createHooks(quiet)
  hooks.addFilter("delivery.entry", "bad", () => {
    throw new Error("nope")
  })
  hooks.addFilter("delivery.entry", "good", p => ({ ...p, payload: { n: 5 } }))

  const result = await hooks.filter("delivery.entry", { payload: { n: 1 } } as any)
  expect((result.payload as any).n).toBe(5)
})

test("a filter returning nothing keeps the previous value", async () => {
  const hooks = createHooks(quiet)
  hooks.addFilter("delivery.entry", "silent", () => undefined as any)
  const result = await hooks.filter("delivery.entry", { payload: { n: 3 } } as any)
  expect((result.payload as any).n).toBe(3)
})

test("removePlugin detaches only that plugin's listeners", async () => {
  const hooks = createHooks(quiet)
  const seen: string[] = []
  hooks.on("server.ready", "keep", () => {
    seen.push("keep")
  })
  hooks.on("server.ready", "drop", () => {
    seen.push("drop")
  })

  hooks.removePlugin("drop")
  await hooks.emit("server.ready", { at: "now" })
  expect(seen).toEqual(["keep"])
})

test("clear detaches everything", async () => {
  const hooks = createHooks(quiet)
  hooks.on("server.ready", "a", () => {})
  hooks.addFilter("delivery.entry", "b", p => p)
  expect(hooks.listenerCount("server.ready")).toBe(1)

  hooks.clear()
  expect(hooks.listenerCount("server.ready")).toBe(0)
  expect(hooks.listenerCount("delivery.entry")).toBe(0)
})

test("clearPlugins preserves core listeners", async () => {
  const hooks = createHooks(quiet)
  const seen: string[] = []
  hooks.on("server.ready", "core", () => {
    seen.push("core")
  })
  hooks.on("server.ready", "seo", () => {
    seen.push("seo")
  })

  hooks.clearPlugins()
  await hooks.emit("server.ready", { at: "now" })

  expect(seen).toEqual(["core"])
  expect(hooks.listenerCount("server.ready")).toBe(1)
})

test("plugin manifests are validated before they can register anything", () => {
  expect(validatePlugin({ name: "seo", version: "1.0.0" }).ok).toBe(true)
  expect(validatePlugin(null).ok).toBe(false)
  expect(validatePlugin({ version: "1.0.0" }).ok).toBe(false)
  expect(validatePlugin({ name: "My-Plugin", version: "1.0.0" }).ok).toBe(false)
  expect(validatePlugin({ name: "seo" }).ok).toBe(false)
  expect(validatePlugin({ name: "seo", version: "1.0.0", routes: "nope" }).ok).toBe(false)
})

test("first-party plugins all load and declare a valid manifest", async () => {
  for (const name of ["seo", "redirects", "forms", "commerce"]) {
    const module = await import(`../plugins/${name}/index.ts`)
    const checked = validatePlugin(module.default)
    expect(checked.ok).toBe(true)
    if (checked.ok) expect(checked.plugin.name).toBe(name)
  }
})
