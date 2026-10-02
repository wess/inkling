import { afterEach, beforeEach, expect, test } from "bun:test"

// The conversation outlives the panel that shows it. There is no DOM here, so
// the browser pieces the store touches are stubbed, and each "reload" is a fresh
// evaluation of the module reading what the last one persisted.

const memory = () => {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  }
}

const sse = (events: [string, unknown][]) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")

const stream = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })

const g = globalThis as Record<string, unknown>
const STUBBED = ["localStorage", "sessionStorage", "location", "window", "document", "fetch"]
// Restored, not deleted: `fetch` is Bun's own, and every test file after this
// one runs in the same process.
const originals = new Map<string, unknown>()
let loads = 0
const boot = () =>
  import(`../src/web/inkystore.ts?load=${++loads}`) as Promise<typeof import("../src/web/inkystore.ts")>

const proposal = {
  id: "p1",
  kind: "settings.update",
  summary: "Rename",
  needs: "settings.manage",
  patch: {},
  before: {},
}

beforeEach(() => {
  for (const key of STUBBED) originals.set(key, g[key])
  g.localStorage = memory()
  g.sessionStorage = memory()
  ;(g.localStorage as ReturnType<typeof memory>).setItem("inkling_token", "token-for-person-one-aaaa")
  g.location = { origin: "http://localhost" }
  g.window = { addEventListener: () => {} }
  g.document = { addEventListener: () => {}, visibilityState: "visible" }
})

afterEach(() => {
  for (const key of STUBBED) {
    if (originals.get(key) === undefined) delete g[key]
    else g[key] = originals.get(key)
  }
})

const settle = () => new Promise(resolve => setTimeout(resolve, 450)) // the persist debounce

test("a conversation is still there after a reload, with what was proposed and what was decided", async () => {
  g.fetch = async () =>
    stream(
      sse([
        ["text", { text: "I can do that." }],
        ["tool", { name: "get_site_settings" }],
        ["proposal", proposal],
        ["done", { history: [{ role: "user" }, { role: "assistant" }] }],
      ]),
    )
  const first = await boot()
  first.setDraft("Rename the site")
  await first.send({ screen: "dashboard" })
  first.decide("p1", "applied")
  await settle()

  const after = (await boot()).readInky()
  expect(after.turns.map(t => t.role)).toEqual(["you", "agent"])
  expect(after.turns[0]?.text).toBe("Rename the site")
  expect(after.turns[1]?.text).toBe("I can do that.")
  expect(after.turns[1]?.tools.map(t => t.name)).toEqual(["get_site_settings"])
  expect(after.proposals.map(p => p.id)).toEqual(["p1"])
  expect(after.decided).toEqual({ p1: "applied" })
  expect(after.history).toHaveLength(2) // so the model remembers it too
  expect(after.running).toBe(false)
})

test("someone else signing in does not inherit the conversation", async () => {
  g.fetch = async () =>
    stream(
      sse([
        ["text", { text: "Hi" }],
        ["done", { history: [] }],
      ]),
    )
  const first = await boot()
  first.setDraft("private question")
  await first.send(undefined)
  await settle()

  ;(g.localStorage as ReturnType<typeof memory>).setItem("inkling_token", "token-for-person-two-bbbb")
  expect((await boot()).readInky().turns).toEqual([])
  // Same tab, no reload: the live module notices too.
  expect(first.readInky().turns).toEqual([])
})

test("an answer cut off by a reload says so instead of leaving a bubble that never fills", async () => {
  g.fetch = () => new Promise(() => {}) // never answers
  const first = await boot()
  first.setDraft("Make it warmer")
  void first.send(undefined)
  await settle()
  expect(first.readInky().running).toBe(true)

  const after = (await boot()).readInky()
  expect(after.running).toBe(false)
  expect(after.turns[1]?.text).toContain("interrupted")
})

test("an answer keeps arriving after the panel that asked is gone, and the page goes to the shelf when it returns", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  g.fetch = async () => {
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(sse([["text", { text: "Looking" }]])))
          await gate
          controller.enqueue(
            encoder.encode(
              sse([
                ["text", { text: " now." }],
                ["proposal", proposal],
                ["done", { history: [] }],
              ]),
            ),
          )
          controller.close()
        },
      }),
      { status: 200 },
    )
  }

  const store = await boot()
  const toasts: string[] = []
  const detach = store.attach({ toast: m => toasts.push(m), onProposal: () => {} })
  store.setDraft("Look at my images")
  const running = store.send(undefined)
  await new Promise(resolve => setTimeout(resolve, 20))

  detach() // the dock closed, or Inky took them to the media library
  release()
  await running

  const state = store.readInky()
  expect(state.turns[1]?.text).toBe("Looking now.")
  expect(state.proposals.map(p => p.id)).toEqual(["p1"])
  expect(state.running).toBe(false)
  expect(toasts).toEqual([])
})

test("a failure with nothing on screen is written into the conversation rather than lost", async () => {
  g.fetch = async () => new Response(JSON.stringify({ error: "Provider unavailable" }), { status: 503 })
  const store = await boot()
  store.setDraft("hello")
  await store.send(undefined) // no panel attached
  expect(store.readInky().turns[1]?.text).toContain("Provider unavailable")
})

test("starting over clears everything, but not while an answer is being written", async () => {
  g.fetch = () => new Promise(() => {})
  const store = await boot()
  store.setDraft("one")
  void store.send(undefined)
  await new Promise(resolve => setTimeout(resolve, 20))
  store.newConversation()
  expect(store.readInky().turns).toHaveLength(2) // refused: still running
})
