import { afterEach, expect, test } from "bun:test"
import { makeKey, sanitize } from "../src/storage/index.ts"
import { createLocalDriver } from "../src/storage/local/index.ts"
import { createS3Driver } from "../src/storage/s3/index.ts"

// The S3 driver went a long time without a test and drifted from the contract
// the local driver defines. Both bugs below were live: neither is visible from
// a type check, and both only surface against a real bucket.

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

const settings = {
  endpoint: "https://nyc3.digitaloceanspaces.com",
  bucket: "bucket",
  region: "nyc3",
  accessKey: "key",
  secretKey: "secret",
  publicUrl: "",
  prefix: "",
}

// Records the URL each stubbed request went to, so a test can assert where in
// the bucket an object landed rather than only what came back.
const recordRequests = (status: number, body = "") => {
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input))
    return new Response(status === 204 ? null : body, { status })
  }) as unknown as typeof fetch
  return seen
}

const recordHeaders = (status: number) => {
  const seen: Headers[] = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return new Response(null, { status })
  }) as unknown as typeof fetch
  return seen
}

const respondWith = (status: number, body = "") => {
  // Cast through `unknown`: the stub has no `fetch.preconnect`, and nothing
  // under test calls it.
  globalThis.fetch = (async () => new Response(status === 204 ? null : body, { status })) as unknown as typeof fetch
}

test("without a CDN, an upload's URL routes back through the media API", async () => {
  // A Spaces bucket is private by default, so returning the bucket URL here
  // hands consuming sites a link that 403s on every <img>. Root-relative keeps
  // reads on the guarded /media/file path and matches the local driver.
  respondWith(200)
  const driver = createS3Driver(settings)

  const { url } = await driver.put("2026/08/abc/photo.png", new Uint8Array([1]), "image/png")

  expect(url).toBe("/media/file/2026/08/abc/photo.png")
})

test("a configured public base still wins, so a CDN keeps serving reads", async () => {
  respondWith(200)
  const driver = createS3Driver({ ...settings, publicUrl: "https://cdn.example.com/" })

  const { url } = await driver.put("2026/08/abc/photo.png", new Uint8Array([1]), "image/png")

  expect(url).toBe("https://cdn.example.com/2026/08/abc/photo.png")
})

test("a missing object reads as null rather than throwing", async () => {
  // src/media keys its 404 on `null`. atlas/storage's `download` throws on any
  // non-2xx, so an object missing from the bucket used to surface as a 500.
  respondWith(404, "<Error><Code>NoSuchKey</Code></Error>")
  const driver = createS3Driver(settings)

  expect(await driver.get("gone.png")).toBeNull()
})

test("a credential failure still throws instead of looking like a missing file", async () => {
  // The dangerous direction: laundering a 403 into `null` turns a misconfigured
  // bucket into a site of quiet 404s rather than an error anyone would notice.
  respondWith(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>")
  const driver = createS3Driver(settings)

  expect(driver.get("photo.png")).rejects.toThrow()
})

test("the local driver agrees on both halves of that contract", async () => {
  const dir = `/tmp/inkling-storage-test-${crypto.randomUUID()}`
  const driver = createLocalDriver(dir)

  const { url } = await driver.put("a/b/photo.png", "payload", "image/png")
  expect(url).toBe("/media/file/a/b/photo.png")

  expect(await driver.get("missing.png")).toBeNull()
  expect(await new Response(await driver.get("a/b/photo.png")).text()).toBe("payload")
})

test("a prefix scopes every operation to one site's corner of a shared bucket", async () => {
  const driver = createS3Driver({ ...settings, prefix: "warren" })

  const puts = recordRequests(200)
  await driver.put("2026/08/abc/photo.png", new Uint8Array([1]), "image/png")
  expect(puts[0]).toBe("https://nyc3.digitaloceanspaces.com/bucket/warren/2026/08/abc/photo.png")

  const gets = recordRequests(200, "x")
  await driver.get("2026/08/abc/photo.png")
  expect(gets[0]).toBe("https://nyc3.digitaloceanspaces.com/bucket/warren/2026/08/abc/photo.png")

  const drops = recordRequests(204)
  await driver.drop("2026/08/abc/photo.png")
  expect(drops[0]).toBe("https://nyc3.digitaloceanspaces.com/bucket/warren/2026/08/abc/photo.png")
})

test("the prefix stays out of the stored URL, so the database survives changing it", async () => {
  // storage_key and the /media/file path are both prefix-free. Re-prefixing a
  // site, or moving it to a bucket of its own, is then an env change and a blob
  // copy — never a data migration.
  respondWith(200)
  const driver = createS3Driver({ ...settings, prefix: "warren" })

  const { url } = await driver.put("2026/08/abc/photo.png", new Uint8Array([1]), "image/png")

  expect(url).toBe("/media/file/2026/08/abc/photo.png")
})

test("a CDN base and a prefix compose into the object's real public URL", async () => {
  respondWith(200)
  const driver = createS3Driver({
    ...settings,
    prefix: "warren",
    publicUrl: "https://wessdev.nyc3.cdn.digitaloceanspaces.com",
  })

  const { url } = await driver.put("2026/08/abc/photo.png", new Uint8Array([1]), "image/png")

  expect(url).toBe("https://wessdev.nyc3.cdn.digitaloceanspaces.com/warren/2026/08/abc/photo.png")
})

test("a prefix written with stray slashes does not produce a doubled path", async () => {
  const driver = createS3Driver({ ...settings, prefix: "/warren/" })

  const puts = recordRequests(200)
  await driver.put("a.png", new Uint8Array([1]), "image/png")

  expect(puts[0]).toBe("https://nyc3.digitaloceanspaces.com/bucket/warren/a.png")
})

test("a bucket served straight to browsers gets objects written public-read", async () => {
  // The ACL and the URL are decided by the same setting on purpose: a public
  // base with private objects is a CDN that 403s on every image.
  const driver = createS3Driver({ ...settings, publicUrl: "https://cdn.example.com" })

  const headers = recordHeaders(200)
  await driver.put("a.png", new Uint8Array([1]), "image/png")

  expect(headers[0]?.get("x-amz-acl")).toBe("public-read")
  expect(headers[0]?.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=key\//)
  // Signed over the ACL header, or Spaces rejects the request.
  expect(headers[0]?.get("authorization")).toMatch(/SignedHeaders=[^,]*x-amz-acl/)
})

test("a private bucket is never widened to public-read behind your back", async () => {
  const driver = createS3Driver(settings)

  const headers = recordHeaders(200)
  await driver.put("a.png", new Uint8Array([1]), "image/png")

  expect(headers[0]?.get("x-amz-acl")).toBeNull()
})

test("a rejected public upload fails loudly rather than recording a missing object", async () => {
  const driver = createS3Driver({ ...settings, publicUrl: "https://cdn.example.com" })
  respondWith(403, "AccessDenied")

  expect(driver.put("a.png", new Uint8Array([1]), "image/png")).rejects.toThrow(/HTTP 403/)
})

test("s3 refuses to start without the settings it cannot work without", () => {
  expect(() => createS3Driver({ ...settings, bucket: "" })).toThrow(/S3_BUCKET/)
  expect(() => createS3Driver({ ...settings, endpoint: "" })).toThrow(/S3_ENDPOINT/)
})

test("keys are dated, unguessable, and safe to put in a path", () => {
  const key = makeKey("My Photo!!.png")
  const now = new Date()
  const prefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/`

  expect(key.startsWith(prefix)).toBe(true)
  // 8 bytes of randomness — the key is the only guard on a public media URL.
  expect(key.slice(prefix.length).split("/")[0]).toMatch(/^[0-9a-f]{16}$/)
  expect(key.endsWith("/My-Photo-.png")).toBe(true)

  expect(makeKey("a.png")).not.toBe(makeKey("a.png"))
})

test("sanitize strips traversal and never yields an empty name", () => {
  expect(sanitize("../../etc/passwd")).toBe("etc-passwd")
  expect(sanitize("...")).toBe("file")
  expect(sanitize("")).toBe("file")
})
