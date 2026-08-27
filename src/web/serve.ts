import { join } from "node:path"
import { config } from "../config/index.ts"

// The admin is bundled by the same process that serves the API, and handed back
// as a plain handler rather than a second server. There is no proxy and no
// second port: the API answers under /api, and everything the router doesn't
// claim falls through to here.

// Dev-only. In production this must be false: with it on, the admin is bundled
// against the dev JSX runtime (jsxDEV) while React resolves to the production
// build that has no such export, and every component throws on first render.
const isDev = config.environment !== "production"

const HERE = import.meta.dir

// A request is for a file (not an admin navigation) when its last path segment
// has a dot. Admin routes never do, so this avoids keeping a route allowlist in
// sync with the client — an out-of-date list shows up as a 404 body, which on a
// top-level Safari navigation becomes a download prompt.
const looksLikeFile = (path: string): boolean => (path.split("/").pop() ?? "").includes(".")

export type AdminHandler = (url: URL) => Promise<Response>

// The admin holds a fourteen-day bearer token in localStorage, which makes any
// script running on this origin a session thief. A CSP is what stops that being
// one bad `innerHTML` away, so it is set here rather than left to
// `withSecurityHeaders` — a policy for a document has to be written against that
// document's own output, and the API and media responses want different answers
// (media in particular must stay embeddable cross-origin).
//
// Bun.build emits the bundle as external module chunks, so `script-src 'self'`
// covers everything except the one inline line above; that one is pinned by
// hash rather than allowed with 'unsafe-inline', which would defeat the point.
// Styles keep 'unsafe-inline' because React writes style attributes, and there
// is no hash for those.
//
// `connect-src` names the WebSocket origin explicitly. `'self'` does cover
// ws://same-origin in current browsers, but the rule is subtle enough that
// saying it plainly is worth the extra characters.
const documentCsp = async (inlineScript: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inlineScript))
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
  const socket = config.publicUrl.replace(/^http/, "ws").replace(/\/+$/, "")

  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    // Media may be on a CDN, and an entry's rich text can carry a remote image.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${socket}`,
    "media-src 'self' blob: https:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

// `base` is where the admin answers: "/" standalone, or a prefix like "/admin"
// when a host owns the root. It has to reach three places — the emitted asset
// URLs, the asset lookup, and the SPA's own routing — so it is injected into the
// document rather than baked into the bundle, and the same build serves either.
export const buildAdmin = async (base = "/"): Promise<AdminHandler> => {
  const prefix = base === "/" ? "" : base.replace(/\/+$/, "")

  const result = await Bun.build({
    entrypoints: [join(HERE, "index.html")],
    target: "browser",
    minify: !isDev,
    sourcemap: isDev ? "inline" : "none",
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error("admin bundle failed")
  }

  const index = result.outputs.find(output => output.path === "./index.html")
  if (!index) throw new Error("admin bundle did not emit an index document")

  // Keep the build in memory. Writing hashed chunks to a shared directory
  // leaves every prior build behind, and there is no reason for runtime output
  // to outlive the process serving it.
  const assets = new Map(
    result.outputs.filter(output => output !== index).map(output => [output.path.replace(/^\.\//, ""), output]),
  )

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
  // The SPA reads its own routes off location.pathname, so it has to be told
  // what part of the path is the mount point rather than a route.
  const baseScript = `window.__INKLING_BASE__=${JSON.stringify(prefix)}`

  const indexHtml = (await index.text())
    .replace(/ crossorigin(?=[\s>])/g, "")
    .replace(/(src|href)="\.\/(chunk-)/g, `$1="${prefix}/$2`)
    .replace("</head>", `<script>${baseScript}</script></head>`)

  const csp = await documentCsp(baseScript)

  const document = () =>
    new Response(indexHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The admin is a private surface; nothing about it should be indexed or
        // held by a shared cache.
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
        "content-security-policy": csp,
      },
    })

  const asset = (path: string): Response | null => {
    const safe = path.replace(/^\/+/, "")
    if (safe.includes("..")) return null
    const file = assets.get(safe)
    if (!file) return null
    return new Response(file, {
      headers: {
        "content-type": file.type,
        "cache-control": "public, max-age=31536000, immutable",
      },
    })
  }

  const withoutPrefix = (pathname: string): string =>
    prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || "/" : pathname

  return async url => {
    const path = withoutPrefix(url.pathname)
    if (!looksLikeFile(path)) return document()
    return asset(path) ?? new Response("Not found", { status: 404 })
  }
}
