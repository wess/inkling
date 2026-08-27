import { expect, test } from "bun:test"
import { buildAdmin } from "../src/web/serve.ts"

test("the admin serves one in-memory build with immutable assets", async () => {
  const handle = await buildAdmin("/admin")
  const document = await handle(new URL("http://localhost/admin/c/post/example"))

  expect(document.status).toBe(200)
  expect(document.headers.get("cache-control")).toBe("no-store")
  expect(document.headers.get("content-security-policy")).toContain("script-src 'self'")

  const html = await document.text()
  const paths = [...html.matchAll(/(?:src|href)="(\/admin\/chunk-[^"]+)"/g)].map(match => match[1] as string)
  expect(paths.length).toBeGreaterThanOrEqual(2)

  for (const path of paths) {
    const asset = await handle(new URL(`http://localhost${path}`))
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(asset.headers.get("content-type")).toMatch(/javascript|css/)
    expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0)
  }

  expect((await handle(new URL("http://localhost/admin/missing.js"))).status).toBe(404)
})
