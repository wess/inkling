import type { Connection } from "atlas/db"
import type { Conn, Route } from "atlas/server"
import {
  badRequest,
  del,
  get,
  json,
  methodNotAllowed,
  notFound,
  options,
  parseJson,
  patch,
  pipeline,
  post,
  put,
} from "atlas/server"
import { requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { body, corsAll, preflight } from "../http/index.ts"
import { readScope, writeSetting } from "../settings/index.ts"
import type { Hooks } from "./hooks.ts"
import type { LoadedPlugin, Registry } from "./index.ts"
import { uninstallPlugin } from "./index.ts"

const summarize = (entry: LoadedPlugin) => ({
  name: entry.plugin.name,
  label: entry.plugin.label ?? entry.plugin.name,
  version: entry.plugin.version,
  description: entry.plugin.description ?? null,
  author: entry.plugin.author ?? null,
  requires: entry.plugin.requires ?? [],
  enabled: entry.enabled,
  installedVersion: entry.installedVersion,
  error: entry.error ?? null,
  upgradable: entry.enabled && entry.installedVersion !== null && entry.installedVersion !== entry.plugin.version,
  contentTypes: (entry.plugin.contentTypes ?? []).map(t => t.name),
  taxonomies: (entry.plugin.taxonomies ?? []).map(t => t.name),
  panels: entry.plugin.panels ?? [],
  settings: entry.plugin.settings ?? [],
})

// Plugin routes are declared as ordinary Route objects but must reach a router
// that was compiled at boot. Rather than rebuilding Bun.serve whenever a plugin
// is toggled, the server mounts one wildcard per method under /ext and it
// resolves against the registry's *current* route list on each request.
// /ext is deliberately separate from /plugins (the management API) so a plugin
// route can never shadow `POST /plugins/:name/enable`.
export const pluginDispatch = (registry: Registry): Route[] => {
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

  const match = (method: string, path: string): { route: Route; params: Record<string, string> } | null => {
    const pathParts = path.split("/")

    for (const route of registry.routes()) {
      if (route.method !== method) continue

      const routeParts = route.pattern.split("/")
      const wildcard = routeParts[routeParts.length - 1] === "*"
      const fixed = wildcard ? routeParts.slice(0, -1) : routeParts

      if (wildcard ? pathParts.length < fixed.length : fixed.length !== pathParts.length) continue

      const params: Record<string, string> = {}
      let ok = true
      for (const [index, part] of fixed.entries()) {
        const value = pathParts[index] as string
        if (part.startsWith(":")) params[part.slice(1)] = value
        else if (part !== value) {
          ok = false
          break
        }
      }
      if (ok) return { route, params }
    }
    return null
  }

  const handler = (method: string) => async (c: Conn) => {
    const found = match(method, c.path)
    if (!found) {
      // Distinguish "no such plugin route" from "wrong verb" so a plugin author
      // debugging a 404 can tell which mistake they made.
      const otherVerb = methods.some(m => m !== method && match(m, c.path) !== null)
      if (otherVerb) throw methodNotAllowed(`${method} is not supported at ${c.path}`)
      throw notFound(`No plugin route matches ${c.path}`)
    }
    return found.route.handler({ ...c, params: { ...c.params, ...found.params } })
  }

  return [
    get("/ext/*", handler("GET")),
    post("/ext/*", handler("POST")),
    put("/ext/*", handler("PUT")),
    patch("/ext/*", handler("PATCH")),
    del("/ext/*", handler("DELETE")),
    options("/ext/*", pipeline(corsAll)(preflight)),
  ]
}

export const pluginRoutes = (db: Connection, hooks: Hooks, registry: Registry, dir: string): Route[] => {
  const read = pipeline(requireAuth(db))
  const manage = pipeline(requireAuth(db), requireCan(can.managePlugins, "manage plugins"))
  const manageJson = pipeline(requireAuth(db), requireCan(can.managePlugins, "manage plugins"), parseJson)

  const load = (name: string): LoadedPlugin => {
    const entry = registry.get(name)
    if (!entry) throw notFound(`Plugin "${name}" is not installed`)
    return entry
  }

  return [
    get(
      "/plugins",
      read(async c => json(c, 200, { data: registry.all().map(summarize) })),
    ),

    get(
      "/plugins/:name",
      read(async c => {
        const entry = load(c.params.name ?? "")
        const declared = Object.fromEntries((entry.plugin.settings ?? []).map(s => [s.key, s.default ?? null]))
        return json(c, 200, {
          ...summarize(entry),
          settingsValues: { ...declared, ...(await readScope(db, entry.plugin.name)) },
        })
      }),
    ),

    post(
      "/plugins/:name/enable",
      manage(async c => {
        const entry = load(c.params.name ?? "")
        if (entry.error)
          throw badRequest(`Plugin "${entry.plugin.name}" failed to load: ${entry.error}`, { code: "LOAD_FAILED" })

        try {
          const result = await registry.enable(entry.plugin.name)
          return json(c, 200, { enabled: result.enabled, data: summarize(load(entry.plugin.name)) })
        } catch (error) {
          throw badRequest((error as Error).message, { code: "ENABLE_FAILED" })
        }
      }),
    ),

    post(
      "/plugins/:name/disable",
      manage(async c => {
        const entry = load(c.params.name ?? "")
        try {
          await registry.disable(entry.plugin.name)
          return json(c, 200, { data: summarize(load(entry.plugin.name)) })
        } catch (error) {
          throw badRequest((error as Error).message, { code: "DISABLE_FAILED" })
        }
      }),
    ),

    put(
      "/plugins/:name/settings",
      manageJson(async c => {
        const entry = load(c.params.name ?? "")
        const declared = new Set((entry.plugin.settings ?? []).map(s => s.key))
        const input = body(c)

        const unknown = Object.keys(input).filter(key => !declared.has(key))
        if (unknown.length > 0) {
          throw badRequest(
            `"${entry.plugin.name}" does not declare setting${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
            {
              code: "UNKNOWN_SETTING",
            },
          )
        }

        for (const [key, value] of Object.entries(input)) {
          await writeSetting(db, entry.plugin.name, key, value)
        }
        // Settings can change what a plugin registers, so re-register it.
        await registry.reload()

        return json(c, 200, { data: await readScope(db, entry.plugin.name) })
      }),
    ),

    // Destructive: rolls back the plugin's migrations and drops its content
    // types, taxonomies, and settings. `disable` is the reversible option.
    del(
      "/plugins/:name",
      manage(async c => {
        const entry = load(c.params.name ?? "")
        if (entry.enabled) throw badRequest("Disable the plugin before uninstalling it", { code: "STILL_ENABLED" })
        if (c.query.confirm !== entry.plugin.name) {
          throw badRequest(
            `Pass ?confirm=${entry.plugin.name} to confirm — this deletes the plugin's content and tables`,
            {
              code: "CONFIRM_REQUIRED",
            },
          )
        }

        await uninstallPlugin(db, hooks, entry, dir)
        await registry.reload()
        return json(c, 200, { uninstalled: entry.plugin.name })
      }),
    ),

    post(
      "/plugins/reload",
      manage(async c => {
        await registry.reload()
        return json(c, 200, { data: registry.all().map(summarize) })
      }),
    ),
  ]
}
