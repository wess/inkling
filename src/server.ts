import { from } from "@atlas/db"
import { withSecurityHeaders } from "@atlas/security"
import { get, json, pipe, router } from "@atlas/server"
import { auditRoutes, registerContentAudit } from "./audit/index.ts"
import { authRoutes } from "./auth/index.ts"
import { config } from "./config/index.ts"
import { contentTypeRoutes } from "./contenttypes/index.ts"
import { countRows } from "./db/dialect.ts"
import { db } from "./db/index.ts"
import { deliveryRoutes } from "./delivery/index.ts"
import { entryRoutes, publishDue } from "./entries/index.ts"
import { apiKeyRoutes } from "./keys/index.ts"
import { mediaRoutes } from "./media/index.ts"
import { menuRoutes } from "./menus/index.ts"
import { up as migrate } from "./migrate/index.ts"
import { createHooks } from "./plugins/hooks.ts"
import { createRegistry } from "./plugins/index.ts"
import { pluginDispatch, pluginRoutes } from "./plugins/routes.ts"
import { searchRoutes } from "./search/index.ts"
import { createRateLimit } from "./security/index.ts"
import { settingsRoutes } from "./settings/index.ts"
import { storageFromConfig } from "./storage/index.ts"
import { taxonomyRoutes } from "./taxonomy/index.ts"
import { now } from "./time/index.ts"
import { createUser, userRoutes } from "./users/index.ts"
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
  console.warn(`no users exist — open ${config.appUrl} to create the first owner account`)
}

// 3. Shared services.
const store = storageFromConfig()
const hooks = createHooks()
registerWebhookBridge(db, hooks)
registerContentAudit(db, hooks)

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

// 5. Routes. Order matters only in that the wildcard /ext dispatcher must not
// shadow a concrete path — it doesn't, since router matching is exact-first.
const routes = [
  get(
    "/health",
    pipe(c => json(c, 200, { status: "ok", at: now() })),
  ),

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
  ...pluginRoutes(db, hooks, registry, config.pluginDir),
  ...pluginDispatch(registry),

  // Public, API-key authenticated. Everything above needs a session.
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

// 7. Serve. withSecurityHeaders also stashes the real socket peer on the
// request, which is what src/security#clientIp reads instead of trusting
// a client-supplied X-Forwarded-For.
const handler = withSecurityHeaders(router(...routes), {
  dev: config.environment !== "production",
  // This origin serves JSON and media only; the admin SPA is a separate
  // process with its own CSP, so a document policy here would be noise.
  disableCsp: true,
})

Bun.serve({ port: config.port, hostname: config.host, fetch: handler })

console.log(`inkling api on http://${config.host}:${config.port} (${db.dialect})`)
