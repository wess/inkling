import { afterEach, expect, spyOn, test } from "bun:test"
import { request } from "../src/web/api.ts"

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
let mock: ReturnType<typeof spyOn> | undefined

const response = (body: string, status: number, type: string) => {
  const removed: string[] = []
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://test.example" } })
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => "test-session",
      removeItem: (key: string) => removed.push(key),
    },
  })
  mock = spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status, headers: { "content-type": type } }))
  return removed
}

afterEach(() => {
  mock?.mockRestore()
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation)
  else Reflect.deleteProperty(globalThis, "location")
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage)
  else Reflect.deleteProperty(globalThis, "localStorage")
})

test("an HTML fallback cannot masquerade as a successful save", async () => {
  response("<!doctype html><title>Inkling</title>", 200, "text/html")
  await expect(request("/entries/example", { method: "PUT", body: { title: "Changed" } })).rejects.toThrow(
    "not confirmed",
  )
})

test("an expired session is cleared even when the server response is not JSON", async () => {
  const removed = response("Sign in", 401, "text/plain")
  await expect(request("/entries/example")).rejects.toThrow("not confirmed")
  expect(removed).toEqual(["inkling_token"])
})

test("save failures preserve field details for the editor's recovery controls", async () => {
  response(
    JSON.stringify({
      error: "Some fields need attention",
      details: { fields: [{ key: "title", message: "is required" }] },
    }),
    400,
    "application/json",
  )
  await expect(request("/entries/example")).rejects.toMatchObject({
    status: 400,
    details: { fields: [{ key: "title", message: "is required" }] },
  })
})

test("network failures explain how to retry without clearing the session", async () => {
  const removed = response("{}", 200, "application/json")
  mock?.mockRejectedValue(new TypeError("Load failed"))
  await expect(request("/entries/example", { method: "PUT", body: { title: "Changed" } })).rejects.toMatchObject({
    status: 0,
    code: "NETWORK_ERROR",
    message: "Could not reach the site. Check your connection, then try again. Your edits are still here.",
  })
  expect(removed).toEqual([])
})

test("preview cancellation reaches the fetch and remains distinguishable from a network error", async () => {
  response("{}", 200, "application/json")
  const abort = new AbortController()
  abort.abort()
  const error = new DOMException("Aborted", "AbortError")
  mock?.mockRejectedValue(error)
  const { api } = await import("../src/web/api.ts")
  await expect(api.previewEntry("example", undefined, abort.signal)).rejects.toBe(error)
  expect(mock?.mock.calls[0]?.[1]?.signal).toBe(abort.signal)
})

test("a truncated Inky stream reports interruption instead of silently succeeding", async () => {
  response('event: text\ndata: {"text":"Let me check"}\n\n', 200, "text/event-stream")
  const { runAgent } = await import("../src/web/api.ts")
  await expect(runAgent({ message: "Update the footer" }, () => {})).rejects.toThrow("ended before the answer finished")
})
