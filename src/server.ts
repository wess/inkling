import { createInkling } from "./app.ts"

// Standalone Inkling: one process, one port, admin at the root. Everything that
// assembles the thing lives in ./app.ts, because a site that wants its CMS on
// its own origin mounts exactly the same object — this file is only the part
// that owns a port, which an embedding host owns instead.

const inkling = await createInkling({ adminBase: "/" })
const { config } = inkling

Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 60,
  // Bun buffers a whole request body before any handler runs, and its default
  // ceiling is 128MB. Nothing downstream can help: `parseJson` calls
  // `request.json()` on whatever arrived, and the upload limit in src/media is
  // checked *after* multipart has already been parsed into memory. So any
  // account could hold 128MB per request, and a handful at once is an OOM on a
  // box this size.
  //
  // Refusing at the socket is the only place that costs nothing. The headroom
  // over MAX_UPLOAD_BYTES is for multipart framing and the other fields in the
  // form; the real per-file limit stays where an operator configured it.
  maxRequestBodySize: config.maxUploadBytes + 2 * 1024 * 1024,
  fetch: async (request, server) => {
    // A WebSocket upgrade has to be answered before the router sees the request
    // — once `fetch` returns a Response the handshake is gone.
    if (request.headers.get("upgrade") === "websocket") {
      if (inkling.upgrade(request, server)) return undefined as unknown as Response
    }

    // `server` is passed for the socket peer, which security headers stash on
    // the request for rate-limit buckets and audit rows to read.
    //
    // With the admin at "/" nothing is left unclaimed, so the null branch is
    // unreachable here; it is the seam an embedding host routes through.
    return (await inkling.fetch(request, server)) ?? new Response("Not found", { status: 404 })
  },
  websocket: inkling.websocket,
})

console.log(`inkling on ${config.publicUrl} (${inkling.db.dialect})`)
console.log(`  admin   ${config.publicUrl}/`)
console.log(`  api     ${config.publicUrl}/api`)
console.log(`  content ${config.publicUrl}/content`)
