import { dirname, isAbsolute, resolve } from "node:path"
import { from } from "atlas/db"
import { withSecurityHeaders } from "atlas/security"
import { get, json, pipe, router } from "atlas/server"
import { agentKeyRoutes } from "./agents/index.ts"
import { agentRoutes } from "./ai/agent.ts"
import { assistantRoutes } from "./ai/assistant.ts"
import { aiPublicRoutes, aiRoutes } from "./ai/index.ts"
import { auditRoutes, registerContentAudit } from "./audit/index.ts"
import { authRoutes } from "./auth/index.ts"
import { config } from "./config/index.ts"
import { contentTypeRoutes } from "./contenttypes/index.ts"
import { countRows } from "./db/dialect.ts"
import { db } from "./db/index.ts"
import { deliveryRoutes } from "./delivery/index.ts"
import { entryRoutes, publishDue } from "./entries/index.ts"
import { prefixed } from "./http/index.ts"
import { apiKeyRoutes, ensureNamedKey } from "./keys/index.ts"
import { mediaFileRoutes, mediaRoutes } from "./media/index.ts"
import { menuRoutes } from "./menus/index.ts"
import { up as migrate } from "./migrate/index.ts"
import { createHooks } from "./plugins/hooks.ts"
import { createRegistry } from "./plugins/index.ts"
import { pluginDispatch, pluginRoutes } from "./plugins/routes.ts"
import { previewPublicRoutes, previewRoutes } from "./preview/index.ts"
import { createRealtime, type Realtime } from "./realtime/index.ts"
import { searchRoutes } from "./search/index.ts"
import { createRateLimit } from "./security/index.ts"
import { settingsRoutes } from "./settings/index.ts"
import { socialPublicRoutes, socialRoutes } from "./social/index.ts"
import { publishDue as publishSocialDue } from "./social/publish.ts"
import { storageFromConfig } from "./storage/index.ts"
import { taxonomyRoutes } from "./taxonomy/index.ts"
import { now } from "./time/index.ts"
import { createUser, userRoutes } from "./users/index.ts"
import { buildAdmin } from "./web/serve.ts"
import { registerWebhookBridge, webhookRoutes } from "./webhooks/index.ts"

// Inkling as something a host process can mount, rather than a server that owns
// the port. `src/server.ts` is the standalone spelling of exactly this — it
// calls createInkling and hands the result to Bun.serve — and a site that wants
// its CMS on its own origin calls it directly instead.
//
// The composition order below is load-bearing and unchanged from when this was
// one script: migrate → bootstrap the first owner → services → plugins →
// routes → admin bundle → sweeps.

// Migrations and plugins ship *with* this package, so their paths are resolved
// against it rather than the working directory. Standalone the two are the same
// directory; embedded they are not, and a cwd-relative default would send
// Inkling looking for the host's ./plugins.
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..")
const fromRoot = (path: string): string => (isAbsolute(path) ? path : resolve(ROOT, path))

export type InklingOptions = {
  // Where the admin answers. "/" is standalone: every unmatched path becomes
  // the admin. A host that owns "/" passes something like "/admin", and then
  // unmatched paths fall through to it as null rather than being swallowed.
  adminBase?: string
  migrationsDir?: string
  pluginDir?: string
  // Mints a delivery key under this name for an in-process consumer. Keys are
  // stored only as a hash, so this re-mints on every boot rather than
  // recovering the previous secret — see ensureNamedKey.
  siteKeyName?: string
}

// Bun.serve hands `fetch` a server exposing the raw socket peer. It is optional
// here only because a test can call `fetch` without one; a real host passes it,
// and `src/security#clientIp` degrades to an empty peer when it does not.
type PeerSource = { readonly requestIP?: (req: Request) => { readonly address: string } | null }

export type Inkling = {
  // Null means no Inkling route claimed the path, so the host may keep routing.
  fetch: (request: Request, server?: PeerSource) => Promise<Response | null>
  // Answers a WebSocket handshake, which has to happen before anything returns
  // a Response. False means the request was not for /realtime.
  upgrade: Realtime["upgrade"]
  websocket: Realtime["websocket"]
  // Spread into `Bun.serve` by whoever owns the port. Values a host inheriting
  // this cannot safely forget — see the comment where it is built.
  serveOptions: { idleTimeout: number; maxRequestBodySize: number }
  siteKey: string | null
  adminBase: string
  db: typeof db
  config: typeof config
  stop: () => void
}

const normalizeBase = (base: string): string => {
  const trimmed = `/${base.replace(/^\/+|\/+$/g, "")}`
  return trimmed === "/" ? "/" : trimmed
}

export const createInkling = async (options: InklingOptions = {}): Promise<Inkling> => {
  if (
    config.environment === "production" &&
    (config.secret === "inkling-dev-secret-change-me" || config.secret.length < 32)
  ) {
    throw new Error("Production requires SECRET to be a unique value of at least 32 characters")
  }

  const adminBase = normalizeBase(options.adminBase ?? "/")

  // 1. Schema first — every module below assumes its tables exist.
  const applied = await migrate(db, fromRoot(options.migrationsDir ?? "./migrations"))
  if (applied.length > 0) console.log(`migrated: ${applied.join(", ")}`)

  // 2. An instance with no users cannot be signed into, and there is no public
  // signup by design. BOOTSTRAP_* creates the first owner exactly once; without
  // it the admin's first-run screen does, and POST /api/auth/setup is the only
  // route that will create an owner.
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
    console.warn(`no users exist — open ${config.publicUrl}${adminBase === "/" ? "" : adminBase} to create the owner`)
  }

  // 3. Shared services.
  const store = storageFromConfig()
  const hooks = createHooks()
  registerWebhookBridge(db, hooks)
  registerContentAudit(db, hooks)

  // Reads the same hook bus the webhook bridge does, so live updates and
  // outbound webhooks describe the same events without either knowing about the
  // other.
  const realtime = createRealtime(db)
  realtime.register(hooks)

  // 4. Plugins register their hooks and routes before the router is built. The
  // route list is resolved per-request through pluginDispatch, so enabling a
  // plugin later does not need a restart.
  const pluginDir = fromRoot(options.pluginDir ?? config.pluginDir)
  const registry = await createRegistry(db, hooks, pluginDir, adminBase === "/" ? "" : adminBase)

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
  //   anything else → the admin, if it is under adminBase
  //
  // The split is by *audience*, not by module: a feature with both a public and
  // a session-gated route exports two arrays (see mediaRoutes / mediaFileRoutes)
  // rather than being mounted twice.
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
      ...agentKeyRoutes(db),
      ...webhookRoutes(db),
      ...searchRoutes(db),
      ...previewRoutes(db),
      ...aiRoutes(db),
      ...assistantRoutes(db),
      ...agentRoutes(db, registry),
      ...socialRoutes(db, store, hooks),
      ...realtime.routes,
      ...pluginRoutes(db, hooks, registry, pluginDir),
    ]),

    get(
      "/health",
      pipe(c => json(c, 200, { status: "ok", at: now() })),
    ),

    // Public. Media keeps its root path because URLs are stored in rows;
    // preview links and delivery keep theirs because they are pasted and
    // integrated elsewhere. The wildcard /ext dispatcher can't shadow any of
    // them — router matching is exact-first.
    ...mediaFileRoutes(db, store),
    ...previewPublicRoutes(db),
    // The OAuth return leg. Public because the provider redirects the browser
    // here by top-level navigation, which carries no bearer token — the sealed
    // `state` is what stands in for a session.
    ...aiPublicRoutes(db, adminBase),
    ...socialPublicRoutes(db, adminBase),
    ...realtime.publicRoutes,
    ...pluginDispatch(registry),
    ...deliveryRoutes(db, hooks),
  ]

  // 6. Bundle the admin before starting anything that needs explicit cleanup.
  // An embedding host may catch a failed boot and try again in the same
  // process; starting intervals first would leave the failed attempt running.
  const admin = await buildAdmin(adminBase)

  // 7. Background sweeps. Small enough not to justify a job runner; each is
  // wrapped so a failure logs rather than killing the interval.
  const limiter = createRateLimit(db)
  const timers: ReturnType<typeof setInterval>[] = []
  const every = (seconds: number, name: string, task: () => Promise<unknown>) =>
    timers.push(
      setInterval(() => {
        void task().catch(error => console.error(`sweep "${name}" failed: ${(error as Error).message}`))
      }, seconds * 1000),
    )

  every(60, "scheduled-publish", () => publishDue(db, hooks))
  // Sent on the same minute boundary as scheduled entries, and for the same
  // reason it is a sweep rather than a timer per post: a process that restarts
  // between the two would lose every timer it was holding, and the row already
  // says when it is due.
  every(60, "social-publish", () => publishSocialDue(db, store, hooks))
  every(3600, "rate-limit-sweep", () => limiter.sweep(86_400))

  await hooks.emit("server.ready", { at: now() })

  // Also stashes the real socket peer on the request, which is what
  // `src/security#clientIp` reads instead of trusting a client-supplied
  // X-Forwarded-For. That makes this correctness rather than decoration: with no
  // peer to read, every rate-limit bucket keys on the same empty string and the
  // per-IP login limit becomes one global bucket shared by every account.
  //
  // It lives here rather than in `src/server.ts` so an embedding host inherits
  // it. Headers are only ever filled in when absent, so a host — or a route like
  // media, which needs `cross-origin` — still wins.
  const handler = withSecurityHeaders(router(...routes), {
    dev: config.environment !== "production",
    // No blanket policy. A CSP only governs a document, and the only document
    // this origin serves is the admin — which sets its own in `src/web/serve.ts`,
    // written against that bundle's actual output and pinning the one inline
    // script by hash. A policy applied to everything would also land on media,
    // where `frame-ancestors 'none'` would stop a consuming site embedding a
    // PDF it is entitled to.
    disableCsp: true,
  })

  // Atlas's router answers an unmatched path with a plain-text 404. Every 404 we
  // raise ourselves is an HttpError, which renders as JSON — so the content type
  // is what distinguishes "no route wanted this" from "the route said no", and
  // only the former may become the admin or fall through to a host.
  const unmatched = (response: Response): boolean =>
    response.status === 404 && (response.headers.get("content-type") ?? "").startsWith("text/plain")

  const underAdmin = (pathname: string): boolean =>
    adminBase === "/" || pathname === adminBase || pathname.startsWith(`${adminBase}/`)

  // 8. A delivery key for a consumer sharing this process. Only meaningful
  // embedded: standalone, the site is elsewhere and mints its own in the admin.
  const siteKey = options.siteKeyName ? await ensureNamedKey(db, options.siteKeyName) : null

  return {
    fetch: async (request, server) => {
      const response = await handler(request, server)
      if (!unmatched(response)) return response
      const url = new URL(request.url)
      // /api and /ext are APIs, and a path neither claimed is a missing route.
      // Handing those to the admin returns its HTML with a 200, so a wrong URL
      // reads to the caller as a successful response it cannot parse — which is
      // exactly how a broken plugin panel looked like a working one.
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ext/")) return response
      return underAdmin(url.pathname) ? admin(url) : null
    },
    upgrade: (request, server) => realtime.upgrade(request, server),
    websocket: realtime.websocket,
    // The `Bun.serve` options a host must not get wrong, for the same reason
    // `withSecurityHeaders` is built here: an embedding host inherits them by
    // spreading this instead of being told to retype them. `idleTimeout` was
    // already missing from every embed example we ship, which is the argument.
    //
    // `maxRequestBodySize` is the load-bearing one. Bun buffers a whole request
    // body before any handler runs, default ceiling 128MB, and nothing
    // downstream can help: `parseJson` calls `request.json()` on whatever
    // arrived, and the upload limit in src/media is checked *after* multipart
    // has been parsed into memory. Refusing at the socket is the only place that
    // costs nothing. The headroom over MAX_UPLOAD_BYTES covers multipart framing
    // and the form's other fields; the real per-file limit stays where an
    // operator configured it.
    serveOptions: {
      idleTimeout: 60,
      maxRequestBodySize: config.maxUploadBytes + 2 * 1024 * 1024,
    },
    siteKey,
    adminBase,
    db,
    config,
    stop: () => {
      for (const timer of timers) clearInterval(timer)
    },
  }
}
