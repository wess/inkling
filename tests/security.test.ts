import { expect, test } from "bun:test"
import { withSecurityHeaders } from "atlas/security"
import { get, json, pipe, putHeader, router } from "atlas/server"
import { storedMime } from "../src/media/index.ts"
import { checkOutboundUrl, clientIp, isPrivateHost } from "../src/security/index.ts"

// The security wrapper is load-bearing for something its name does not suggest:
// it stashes the real socket peer on the request, and `clientIp` reads only that
// rather than a client-supplied X-Forwarded-For. Drop the wrapper and no request
// carries a peer, so every rate-limit bucket keys on the same empty string —
// which turns the per-IP login limit into one global bucket that any single
// client can exhaust for every account at once. That failed silently once; these
// assert it cannot again.

const peer = (address: string) => ({ requestIP: () => ({ address }) })

test("clientIp has nothing to key on when no peer was stashed", () => {
  expect(clientIp(new Request("http://localhost/api/auth/login"))).toBe("")
})

test("the wrapper stashes the socket peer for clientIp to read", async () => {
  let seen = "unset"
  const handle = withSecurityHeaders(request => {
    seen = clientIp(request as Request & { peerIp?: string })
    return new Response("ok")
  })

  await handle(new Request("http://localhost/api/auth/login"), peer("203.0.113.7"))
  expect(seen).toBe("203.0.113.7")
})

test("an untrusted peer cannot spoof its address through X-Forwarded-For", async () => {
  // TRUSTED_PROXIES is empty by default, so the forwarded header is ignored
  // entirely and the bucket keys on the address the socket actually came from.
  let seen = "unset"
  const handle = withSecurityHeaders(request => {
    seen = clientIp(request as Request & { peerIp?: string })
    return new Response("ok")
  })

  await handle(
    new Request("http://localhost/api/auth/login", { headers: { "x-forwarded-for": "10.0.0.1" } }),
    peer("203.0.113.7"),
  )
  expect(seen).toBe("203.0.113.7")
})

test("login buckets separate by peer rather than collapsing into one", async () => {
  const buckets: string[] = []
  const handle = withSecurityHeaders(request => {
    buckets.push(`login:ip:${clientIp(request as Request & { peerIp?: string })}`)
    return new Response("ok")
  })

  await handle(new Request("http://localhost/api/auth/login"), peer("203.0.113.7"))
  await handle(new Request("http://localhost/api/auth/login"), peer("198.51.100.2"))

  expect(new Set(buckets).size).toBe(2)
})

test("responses carry the default headers, and a route's own still wins", async () => {
  const handle = withSecurityHeaders(
    router(
      get(
        "/api/types",
        pipe(c => json(c, 200, { ok: true })),
      ),
      // Media sets this explicitly: the wrapper's `same-site` default would make
      // every <img> on a consuming site fail on an otherwise valid 200. Headers
      // go on the context, the way src/media does it — setting them on a
      // finished Response does not survive.
      get(
        "/media/file/*",
        pipe(c => json(putHeader(c, "cross-origin-resource-policy", "cross-origin"), 200, { blob: true })),
      ),
    ),
    { dev: false, disableCsp: true },
  )

  const api = await handle(new Request("http://localhost/api/types"))
  expect(api.headers.get("x-content-type-options")).toBe("nosniff")
  expect(api.headers.get("x-frame-options")).toBe("DENY")
  expect(api.headers.get("cross-origin-resource-policy")).toBe("same-site")

  const blob = await handle(new Request("http://localhost/media/file/2026/07/abc/x.png"))
  expect(blob.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
})

test("private and loopback addresses are refused as outbound targets", async () => {
  for (const host of [
    "http://localhost/hook",
    "http://127.0.0.1:5432/hook",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/hook",
    "http://192.168.1.10/hook",
    "http://172.16.0.1/hook",
    "http://[::1]/hook",
  ]) {
    const verdict = await checkOutboundUrl(host)
    expect(verdict.ok).toBe(false)
  }

  expect(isPrivateHost("example.com")).toBe(false)
  expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true)
  // 172.32 is outside the private block; the regex has to stop at 172.31.
  expect(isPrivateHost("172.32.0.1")).toBe(false)
  expect(isPrivateHost("172.16.0.1")).toBe(true)
})

test("a scheme other than http(s) is refused outright", async () => {
  for (const value of ["file:///etc/passwd", "gopher://host/", "not a url"]) {
    expect((await checkOutboundUrl(value)).ok).toBe(false)
  }
})

test("an upload's content-type is checked against its bytes", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const markup = new TextEncoder().encode("<!DOCTYPE html><script>fetch('/api/users')</script>")
  const text = new TextEncoder().encode("just some notes")

  // What the bytes are beats what the upload claimed, in both directions.
  expect(storedMime("application/octet-stream", png)).toBe("image/png")
  expect(storedMime("image/png", markup)).toBe("application/octet-stream")
  // A file claiming an inline-safe type we cannot confirm keeps it, unless it
  // opens like a document.
  expect(storedMime("text/plain", text)).toBe("text/plain")
  // Nothing inline-safe was claimed, so there is nothing to demote.
  expect(storedMime("application/zip", markup)).toBe("application/zip")
})
