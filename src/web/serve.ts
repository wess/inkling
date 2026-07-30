import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { config } from "../config/index.ts"

const API = config.apiUrl
const PORT = config.webPort

// Dev-only. In production this must be false: with it on, Bun bundles the SPA
// against the dev JSX runtime (jsxDEV) while resolving React to the production
// build that has no such export, and every component throws on first render.
const isDev = config.environment !== "production"

const HERE = dirname(new URL(import.meta.url).pathname)
const DIST = resolve(HERE, "dist")

const build = async (): Promise<void> => {
  if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true })
  const result = await Bun.build({
    entrypoints: [join(HERE, "index.html")],
    outdir: DIST,
    target: "browser",
    minify: !isDev,
    sourcemap: isDev ? "inline" : "none",
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("admin bundle failed")
  }
}

await build()

// Bun.build emits `crossorigin` on the module script and stylesheet it injects.
// The assets are same-origin, so the attribute is gratuitous — but Safari then
// fetches them in CORS mode, finds no Access-Control-Allow-Origin, refuses to
// execute the module, and offers to download the bundle instead.
//
// It also emits chunk paths as `./chunk-…`, which the browser resolves against
// the current URL. That is fine at `/` and broken everywhere else: loading
// `/c/post/<id>` directly asks for `/c/post/chunk-….js` and gets a 404, so the
// admin renders a blank page on any refresh or deep link. The assets are always
// served from the root, so the paths are made absolute.
const indexHtml = (await Bun.file(join(DIST, "index.html")).text())
  .replace(/ crossorigin(?=[\s>])/g, "")
  .replace(/(src|href)="\.\/(chunk-)/g, '$1="/$2')

const asset = async (path: string): Promise<Response | null> => {
  const safe = path.replace(/^\/+/, "")
  if (safe.includes("..")) return null
  const file = Bun.file(join(DIST, safe))
  return (await file.exists()) ? new Response(file) : null
}

// A request is for a file (not an SPA navigation) when its last path segment
// has a dot. SPA routes never do, so this avoids keeping a route allowlist in
// sync with the client — an out-of-date list shows up as a 404 body, which on
// a top-level Safari navigation becomes a download prompt.
const looksLikeFile = (path: string): boolean => (path.split("/").pop() ?? "").includes(".")

Bun.serve({
  port: PORT,
  idleTimeout: 60,

  fetch: async request => {
    const url = new URL(request.url)

    // Everything the client calls goes through here, so the bearer token and
    // the admin share one origin and never need CORS.
    if (url.pathname.startsWith("/api/")) {
      const target = new URL(url.pathname.replace(/^\/api/, "") + url.search, API)
      const proxied = await fetch(target, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        // Required by undici/Bun when streaming a request body through.
        duplex: "half",
        redirect: "manual",
      } as RequestInit).catch(
        () => new Response(JSON.stringify({ error: "The API is not reachable" }), { status: 502 }),
      )
      return proxied
    }

    if (looksLikeFile(url.pathname)) {
      const file = await asset(url.pathname)
      if (file) return file
      return new Response("Not found", { status: 404 })
    }

    return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } })
  },
})

console.log(`inkling admin on http://localhost:${PORT} (api ${API})`)
