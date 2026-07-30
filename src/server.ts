import { from } from "@atlas/db"
import { withSecurityHeaders } from "@atlas/security"
import { get, json, pipe, router } from "@atlas/server"
import { assistantRoutes } from "./ai/assistant.ts"
import { aiRoutes } from "./ai/index.ts"
import { auditRoutes, registerContentAudit } from "./audit/index.ts"
import { authRoutes } from "./auth/index.ts"
import { config } from "./config/index.ts"
import { contentTypeRoutes } from "./contenttypes/index.ts"
import { countRows } from "./db/dialect.ts"
import { db } from "./db/index.ts"
import { deliveryRoutes } from "./delivery/index.ts"
import { entryRoutes, publishDue } from "./entries/index.ts"
import { prefixed } from "./http/index.ts"
import { apiKeyRoutes } from "./keys/index.ts"
import { mediaFileRoutes, mediaRoutes } from "./media/index.ts"
import { menuRoutes } from "./menus/index.ts"
import { up as migrate } from "./migrate/index.ts"
import { createHooks } from "./plugins/hooks.ts"
import { createRegistry } from "./plugins/index.ts"
import { pluginDispatch, pluginRoutes } from "./plugins/routes.ts"
import { previewPublicRoutes, previewRoutes } from "./preview/index.ts"
import { createRealtime } from "./realtime/index.ts"
import { searchRoutes } from "./search/index.ts"
import { createRateLimit } from "./security/index.ts"
import { settingsRoutes } from "./settings/index.ts"
import { storageFromConfig } from "./storage/index.ts"
import { taxonomyRoutes } from "./taxonomy/index.ts"
import { now } from "./time/index.ts"
import { createUser, userRoutes } from "./users/index.ts"
import { buildAdmin } from "./web/serve.ts"
import { registerWebhookBridge, webhookRoutes } from "./webhooks/index.ts"

if (
  config.environment === "production" &&
  (config.secret === "inkling-dev-secret-change-me" || config.secret.length < 32)
) {
  throw new Error("Production requires SECRET to be a unique value of at least 32 characters")
}

// 1. Schema first — every module below assumes its tables exist.
const applied = await migrate(db, "./migrations")
if (applied.length > 0) console.log(`migrated: ${applied.join(", ")}`)

// 2. An instance with no users cannot be signed into, and there is no public
// signup by design. BOOTSTRAP_* creates the first owner exactly once.
const userCount = await countRows(
  db,
  from("users", "u")
    .select("COUNT(*) as total")
    .where(q => q("u.deleted_at").isNull()),
)

if (userCount === 0 && config.bootstrap.email && config.bootstrap.password) {
  await createUser(db, {
    email: config.bootstrap.email,
    name: config.bootstrap.name,
    password: config.bootstrap.password,
    role: "owner",
  })
  console.log(`created owner account ${config.bootstrap.email}`)
} else if (userCount === 0) {
  console.warn(`no users exist — open ${config.publicUrl} to create the first owner account`)
}

// 3. Shared services.
const store = storageFromConfig()
const hooks = createHooks()
registerWebhookBridge(db, hooks)
registerContentAudit(db, hooks)

// Reads the same hook bus the webhook bridge does, so live updates and outbound
// webhooks describe the same events without either knowing about the other.
const realtime = createRealtime(db)
realtime.register(hooks)

// 4. Plugins register their hooks and routes before the router is built. The
// route list is resolved per-request through pluginDispatch, so enabling a
// plugin later does not need a restart.
const registry = await createRegistry(db, hooks, config.pluginDir)

// Auto-enable on a fresh install so a new instance boots with the intended
// baseline rather than an empty plugin list.
for (const name of config.pluginAutoEnable) {
  const entry = registry.get(name)
  if (entry && !entry.enabled && !entry.error) {
    await registry.enable(name).catch(error => console.error(`could not enable "${name}": ${error.message}`))
  }
}

for (const entry of registry.all()) {
  if (entry.error) console.error(`[plugin:${entry.plugin.name}] not loaded: ${entry.error}`)
}
console.log(`plugins: ${registry.all().filter(e => e.enabled).length} enabled of ${registry.all().length} installed`)

// 5. Routes. One origin, split by path rather than by port.
//
//   /api/…    everything that needs a session — the admin's whole surface
//   /content, /site, /preview, /media/file, /ext, /realtime, /health
//             public: what a website, a share link, or a socket calls
//   anything else → the admin itself
//
// The split is by *audience*, not by module: a feature with both a public and a
// session-gated route exports two arrays (see mediaRoutes / mediaFileRoutes)
// rather than being mounted twice. Nothing under /api is reachable without a
// session, and nothing at the root can be mistaken for an admin screen.
const routes = [
  ...prefixed("/api", [
    ...authRoutes(db),
    ...userRoutes(db),
    ...auditRoutes(db),
    ...contentTypeRoutes(db),
    ...entryRoutes(db, hooks),
    ...mediaRoutes(db, store, hooks),
    ...taxonomyRoutes(db),
    ...menuRoutes(db),
    ...settingsRoutes(db),
    ...apiKeyRoutes(db),
    ...webhookRoutes(db),
    ...searchRoutes(db),
    ...previewRoutes(db),
    ...aiRoutes(db),
    ...assistantRoutes(db),
    ...realtime.routes,
    ...pluginRoutes(db, hooks, registry, config.pluginDir),
  ]),

  get(
    "/health",
    pipe(c => json(c, 200, { status: "ok", at: now() })),
  ),

  // Public. Media keeps its root path because URLs are stored in rows; preview
  // links and delivery keep theirs because they are pasted and integrated
  // elsewhere. The wildcard /ext dispatcher can't shadow any of them — router
  // matching is exact-first.
  ...mediaFileRoutes(db, store),
  ...previewPublicRoutes(db),
  ...realtime.publicRoutes,
  ...pluginDispatch(registry),
  ...deliveryRoutes(db, hooks),
]

// 6. Background sweeps. Small enough not to justify a job runner; each is
// wrapped so a failure logs rather than killing the interval.
const limiter = createRateLimit(db)
const every = (seconds: number, name: string, task: () => Promise<unknown>) =>
  setInterval(() => {
    void task().catch(error => console.error(`sweep "${name}" failed: ${(error as Error).message}`))
  }, seconds * 1000)

every(60, "scheduled-publish", () => publishDue(db, hooks))
every(3600, "rate-limit-sweep", () => limiter.sweep(86_400))

await hooks.emit("server.ready", { at: now() })

// 7. The admin, bundled by this process. No second server and no proxy — it is
// a handler the router falls through to.
const admin = await buildAdmin()

// withSecurityHeaders also stashes the real socket peer on the request, which is
// what src/security#clientIp reads instead of trusting a client-supplied
// X-Forwarded-For.
const handler = withSecurityHeaders(router(...routes), {
  dev: config.environment !== "production",
  // The admin bundle is emitted with hashed chunk names and inline styles, so a
  // document policy would need to be written against that output specifically.
  // Until it is, an unset CSP is honest; a wrong one would be worse.
  disableCsp: true,
})

// Atlas's router answers an unmatched path with a plain-text 404. Every 404 we
// raise ourselves is an HttpError, which renders as JSON — so the content type
// is what distinguishes "no route wanted this" from "the route said no", and
// only the former should become the admin.
const unmatched = (response: Response): boolean =>
  response.status === 404 && (response.headers.get("content-type") ?? "").startsWith("text/plain")

// A WebSocket upgrade has to be answered before the router sees the request —
// once `fetch` returns a Response the handshake is gone. `realtime.upgrade`
// claims only /realtime with a valid ticket and returns false otherwise.
Bun.serve({
  port: config.port,
  hostname: config.host,
  idleTimeout: 60,
  fetch: async (request, server) => {
    if (request.headers.get("upgrade") === "websocket") {
      if (realtime.upgrade(request, server)) return undefined as unknown as Response
    }

    const response = await handler(request)
    return unmatched(response) ? admin(new URL(request.url)) : response
  },
  websocket: realtime.websocket,
})

console.log(`inkling on ${config.publicUrl} (${db.dialect})`)
console.log(`  admin   ${config.publicUrl}/`)
console.log(`  api     ${config.publicUrl}/api`)
console.log(`  content ${config.publicUrl}/content`)
