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
