import { expect, test } from "bun:test"
import { get, json, pipe, router } from "atlas/server"
import { prefixed } from "../src/http/index.ts"

// One origin, split by path. These assert the split itself, because the whole
// reason it exists is that `/settings` was ambiguous between the API and the
// admin screen of the same name — and that ambiguity would come back silently.

const ok = (name: string) =>
  get(
    `/${name}`,
    pipe(c => json(c, 200, { hit: name })),
  )

test("prefixing moves a route without disturbing its shape", () => {
  const routes = prefixed("/api", [ok("settings"), ok("types")])

  expect(routes.map(route => route.pattern)).toEqual(["/api/settings", "/api/types"])
  // Method and handler ride along untouched.
  expect(routes[0]?.method).toBe("GET")
})

test("a root-mounted route is not shadowed by the same name under /api", async () => {
  // `/settings` exists twice: the API's, under /api, and the admin's own screen,
  // which is whatever the router does not claim.
  const handle = router(...prefixed("/api", [ok("settings")]))

  const api = await handle(new Request("http://localhost/api/settings"))
  expect(api.status).toBe(200)
  expect(((await api.json()) as { hit: string }).hit).toBe("settings")

  // The bare path is left for the admin — the router must not answer it.
  const bare = await handle(new Request("http://localhost/settings"))
  expect(bare.status).toBe(404)
})

test("an unmatched path is distinguishable from a route that answered 404", async () => {
  // This is what src/server.ts keys the admin fallback on. Atlas answers an
  // unmatched path with plain text; a 404 we raise ourselves renders as JSON.
  // If that ever stops being true, the admin stops loading — so it is asserted
  // here rather than discovered in a browser.
  const handle = router(
    get(
      "/api/entries/:id",
      pipe(c => json(c, 404, { error: "Entry not found" })),
    ),
  )

  const unmatched = await handle(new Request("http://localhost/c/post/123"))
  expect(unmatched.status).toBe(404)
  expect(unmatched.headers.get("content-type") ?? "").toStartWith("text/plain")

  const answered = await handle(new Request("http://localhost/api/entries/nope"))
  expect(answered.status).toBe(404)
  expect(answered.headers.get("content-type") ?? "").toStartWith("application/json")
})

test("root paths stay reachable alongside the /api tree", async () => {
  const handle = router(
    ...prefixed("/api", [ok("media")]),
    get(
      "/media/file/*",
      pipe(c => json(c, 200, { hit: "blob" })),
    ),
  )

  // The admin's media list.
  expect((await handle(new Request("http://localhost/api/media"))).status).toBe(200)

  // The public blob path, which is stored in rows and cannot move.
  const blob = await handle(new Request("http://localhost/media/file/2026/07/abc/x.png"))
  expect(((await blob.json()) as { hit: string }).hit).toBe("blob")

  // And `/media` itself is free for the admin screen of that name.
  expect((await handle(new Request("http://localhost/media"))).status).toBe(404)
})
