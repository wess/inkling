import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { config } from "../config/index.ts"

// The admin is bundled by the same process that serves the API, and handed back
// as a plain handler rather than a second server. There is no proxy and no
// second port: the API answers under /api, and everything the router doesn't
// claim falls through to here.

// Dev-only. In production this must be false: with it on, the admin is bundled
// against the dev JSX runtime (jsxDEV) while React resolves to the production
// build that has no such export, and every component throws on first render.
const isDev = config.environment !== "production"

const HERE = dirname(new URL(import.meta.url).pathname)
const DIST = resolve(HERE, "dist")

// A request is for a file (not an admin navigation) when its last path segment
// has a dot. Admin routes never do, so this avoids keeping a route allowlist in
// sync with the client — an out-of-date list shows up as a 404 body, which on a
// top-level Safari navigation becomes a download prompt.
const looksLikeFile = (path: string): boolean => (path.split("/").pop() ?? "").includes(".")

export type AdminHandler = (url: URL) => Promise<Response>

export const buildAdmin = async (): Promise<AdminHandler> => {
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

  const document = () =>
    new Response(indexHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The admin is a private surface; nothing about it should be indexed or
        // held by a shared cache.
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    })

  const asset = async (path: string): Promise<Response | null> => {
    const safe = path.replace(/^\/+/, "")
    if (safe.includes("..")) return null
    const file = Bun.file(join(DIST, safe))
    return (await file.exists()) ? new Response(file) : null
  }

  return async url => {
    if (!looksLikeFile(url.pathname)) return document()
    return (await asset(url.pathname)) ?? new Response("Not found", { status: 404 })
  }
}
