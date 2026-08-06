import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import { upsertOwned } from "../contenttypes/index.ts"
import { id } from "../ids/index.ts"
import { downAll as migrateDownAll, up as migrateUp } from "../migrate/index.ts"
import { contentTypes, plugins as pluginsTable, taxonomies } from "../schema/index.ts"
import { clearScope, readScope, readSetting, writeSetting } from "../settings/index.ts"
import { now } from "../time/index.ts"
import type { Plugin, PluginContext } from "./define.ts"
import { validatePlugin } from "./define.ts"
import type { Hooks } from "./hooks.ts"

export type LoadedPlugin = {
  readonly plugin: Plugin
  readonly dir: string
  readonly enabled: boolean
  readonly installedVersion: string | null
  readonly error?: string
}

export type Registry = {
  readonly all: () => LoadedPlugin[]
  readonly get: (name: string) => LoadedPlugin | undefined
  readonly routes: () => Route[]
  readonly enable: (name: string) => Promise<{ enabled: string[] }>
  readonly disable: (name: string) => Promise<void>
  readonly reload: () => Promise<void>
}

const context = (db: Connection, plugin: Plugin, hooks: Hooks, adminBase: string): PluginContext => ({
  db,
  name: plugin.name,
  adminBase,
  on: (name, fn) => hooks.on(name, plugin.name, fn),
  filter: (name, fn) => hooks.addFilter(name, plugin.name, fn),
  getSetting: (key, fallback) => readSetting(db, plugin.name, key, fallback),
  setSetting: (key, value) => writeSetting(db, plugin.name, key, value),
  allSettings: async () => {
    const declared = Object.fromEntries((plugin.settings ?? []).map(s => [s.key, s.default ?? null]))
    return { ...declared, ...(await readScope(db, plugin.name)) }
  },
  log: message => console.log(`[plugin:${plugin.name}] ${message}`),
})

// Import each `<dir>/<name>/index.ts` and take the default export (or a named
// `plugin` export). A plugin that throws on import is recorded with its error
// rather than taking the server down — a broken plugin should be visible and
// disableable in the admin, not a boot failure.
const loadFromDisk = async (dir: string): Promise<{ plugin?: Plugin; dir: string; name: string; error?: string }[]> => {
  const root = resolve(dir)
  if (!existsSync(root)) return []

  const candidates = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => existsSync(`${root}/${name}/index.ts`))
    .sort()

  const loaded = []
  for (const name of candidates) {
    const path = `${root}/${name}/index.ts`
    try {
      const module = await import(path)
      const exported = module.default ?? module.plugin
      const checked = validatePlugin(exported)
      if (!checked.ok) {
        loaded.push({ dir: `${root}/${name}`, name, error: checked.error })
        continue
      }
      if (checked.plugin.name !== name) {
        loaded.push({
          dir: `${root}/${name}`,
          name,
          error: `declares name "${checked.plugin.name}" but lives in directory "${name}"`,
        })
        continue
      }
      loaded.push({ plugin: checked.plugin, dir: `${root}/${name}`, name })
    } catch (error) {
      loaded.push({ dir: `${root}/${name}`, name, error: (error as Error).message })
    }
  }
  return loaded
}

export const createRegistry = async (db: Connection, hooks: Hooks, dir: string, adminBase = ""): Promise<Registry> => {
  let entries: LoadedPlugin[] = []
  // Routes are collected once per enabled plugin and served through a stable
  // wrapper, so enabling a plugin at runtime doesn't require restarting
  // Bun.serve — see mountedRoutes below.
  let mounted = new Map<string, Route[]>()

  const stateRows = async () =>
    db.all<{ name: string; version: string; enabled: number }>(from(pluginsTable).select("name", "version", "enabled"))

  const provision = async (plugin: Plugin): Promise<PluginContext> => {
    const ctx = context(db, plugin, hooks, adminBase)

    // Plugin-owned tables live in <plugin>/migrations and are namespaced in
    // schema_migrations so they can never collide with core migration names.
    const migrations = `${dir}/${plugin.name}/migrations`
    if (existsSync(resolve(migrations))) {
      await migrateUp(db, resolve(migrations), `plugin:${plugin.name}`)
    }

    for (const type of plugin.contentTypes ?? []) {
      const result = await upsertOwned(db, plugin.name, type)
      if (result.skipped) ctx.log(result.skipped)
    }

    for (const taxonomy of plugin.taxonomies ?? []) {
      const existing = await db.one<{ id: string; owner_plugin: string | null }>(
        from(taxonomies)
          .select("id", "owner_plugin")
          .where(q => q("name").equals(taxonomy.name)),
      )
      if (!existing) {
        await db.execute(
          from(taxonomies).insert({
            id: id(),
            name: taxonomy.name,
            label: taxonomy.label,
            hierarchical: taxonomy.hierarchical ? 1 : 0,
            owner_plugin: plugin.name,
            created_at: now(),
          }),
        )
      } else if (existing.owner_plugin !== plugin.name) {
        ctx.log(`taxonomy "${taxonomy.name}" already exists and is not owned by ${plugin.name}`)
      }
    }

    return ctx
  }

  const activate = async (plugin: Plugin): Promise<void> => {
    const ctx = await provision(plugin)

    await plugin.register?.(ctx)

    // Plugins declare routes relative to themselves — `get("/featured", …)` —
    // and are namespaced here, so two plugins can both own "/featured" and
    // neither can reach outside /ext/<name>/.
    if (plugin.routes) {
      const declared = await plugin.routes(ctx)
      mounted.set(
        plugin.name,
        declared.map(route => ({
          ...route,
          pattern: `/ext/${plugin.name}${route.pattern === "/" ? "" : route.pattern}`,
        })),
      )
    }
  }

  const refresh = async (): Promise<void> => {
    // Every enabled plugin re-registers below, so start from an empty bus
    // rather than trying to subtract one plugin's listeners at a time.
    hooks.clearPlugins()
    mounted = new Map()

    const disk = await loadFromDisk(dir)
    const state = new Map((await stateRows()).map(row => [row.name, row]))
    const next: LoadedPlugin[] = []

    for (const found of disk) {
      if (!found.plugin) {
        next.push({
          plugin: { name: found.name, version: "0.0.0" },
          dir: found.dir,
          enabled: false,
          installedVersion: null,
          error: found.error,
        })
        continue
      }

      const row = state.get(found.plugin.name)
      const enabled = row?.enabled === 1
      next.push({
        plugin: found.plugin,
        dir: found.dir,
        enabled,
        installedVersion: row?.version ?? null,
      })
    }

    entries = next

    // Activate in dependency order so a plugin's `requires` are registered
    // before its own register()/routes() run.
    for (const entry of ordered(entries.filter(e => e.enabled && !e.error))) {
      try {
        await activate(entry.plugin)
      } catch (error) {
        console.error(`[plugin:${entry.plugin.name}] failed to activate: ${(error as Error).message}`)
        entries = entries.map(e =>
          e.plugin.name === entry.plugin.name ? { ...e, error: (error as Error).message } : e,
        )
      }
    }
  }

  // Topological sort on `requires`. Unknown or cyclic dependencies don't throw;
  // the plugin is simply placed last and its own activation will surface the
  // problem, which keeps one bad manifest from blocking every other plugin.
  const ordered = (list: LoadedPlugin[]): LoadedPlugin[] => {
    const byName = new Map(list.map(entry => [entry.plugin.name, entry]))
    const seen = new Set<string>()
    const visiting = new Set<string>()
    const out: LoadedPlugin[] = []

    const visit = (entry: LoadedPlugin) => {
      if (seen.has(entry.plugin.name) || visiting.has(entry.plugin.name)) return
      visiting.add(entry.plugin.name)
      for (const dependency of entry.plugin.requires ?? []) {
        const target = byName.get(dependency)
        if (target) visit(target)
      }
      visiting.delete(entry.plugin.name)
      seen.add(entry.plugin.name)
      out.push(entry)
    }

    for (const entry of list) visit(entry)
    return out
  }

  const enable = async (name: string): Promise<{ enabled: string[] }> => {
    const entry = entries.find(e => e.plugin.name === name)
    if (!entry) throw new Error(`Plugin "${name}" is not installed`)
    if (entry.error) throw new Error(`Plugin "${name}" failed to load: ${entry.error}`)

    // Pull in dependencies first, depth-first, so enabling one plugin enables
    // exactly what it needs and reports the whole set back.
    const turnedOn: string[] = []
    const visiting = new Set<string>()
    const walk = async (target: LoadedPlugin) => {
      if (visiting.has(target.plugin.name)) {
        throw new Error(`Plugin dependency cycle includes "${target.plugin.name}"`)
      }
      visiting.add(target.plugin.name)

      for (const dependency of target.plugin.requires ?? []) {
        const found = entries.find(e => e.plugin.name === dependency)
        if (!found) throw new Error(`"${target.plugin.name}" requires "${dependency}", which is not installed`)
        if (found.error) throw new Error(`"${target.plugin.name}" requires "${dependency}", which failed to load`)
        if (!found.enabled && !turnedOn.includes(dependency)) await walk(found)
      }

      // Provision before install so install hooks can use their tables and
      // declared content. Persist enabled/version only after install succeeds;
      // otherwise a failed upgrade would look complete and never be retried.
      const ctx = await provision(target.plugin)
      if (target.installedVersion !== target.plugin.version) {
        await target.plugin.install?.(ctx)
      }

      const existing = await db.one<{ name: string }>(
        from(pluginsTable)
          .select("name")
          .where(q => q("name").equals(target.plugin.name)),
      )

      if (existing) {
        await db.execute(
          from(pluginsTable)
            .update({ enabled: 1, version: target.plugin.version, updated_at: now() })
            .where(q => q("name").equals(target.plugin.name)),
        )
      } else {
        await db.execute(
          from(pluginsTable).insert({
            name: target.plugin.name,
            version: target.plugin.version,
            enabled: 1,
            installed_at: now(),
            updated_at: now(),
          }),
        )
      }

      turnedOn.push(target.plugin.name)
      visiting.delete(target.plugin.name)
    }

    await walk(entry)
    await refresh()
    return { enabled: turnedOn }
  }

  const disable = async (name: string): Promise<void> => {
    const entry = entries.find(e => e.plugin.name === name)
    if (!entry) throw new Error(`Plugin "${name}" is not installed`)

    const dependents = entries
      .filter(e => e.enabled && e.plugin.name !== name && (e.plugin.requires ?? []).includes(name))
      .map(e => e.plugin.name)
    if (dependents.length > 0) {
      throw new Error(
        `Disable ${dependents.join(", ")} first — ${dependents.length > 1 ? "they depend" : "it depends"} on "${name}"`,
      )
    }

    await db.execute(
      from(pluginsTable)
        .update({ enabled: 0, updated_at: now() })
        .where(q => q("name").equals(name)),
    )

    hooks.removePlugin(name)
    mounted.delete(name)
    await refresh()
  }

  await refresh()

  return {
    all: () => entries,
    get: name => entries.find(e => e.plugin.name === name),
    routes: () => [...mounted.values()].flat(),
    enable,
    disable,
    reload: refresh,
  }
}

// Fully removes a plugin's data: its migrations are rolled back, its content
// types and taxonomies dropped, its settings cleared. Separate from `disable`
// because disabling is meant to be reversible and this is not.
export const uninstallPlugin = async (
  db: Connection,
  hooks: Hooks,
  entry: LoadedPlugin,
  dir: string,
): Promise<void> => {
  // Uninstall drops tables and clears settings; nothing it does redirects a
  // browser, so the admin's location is not worth threading this far.
  await entry.plugin.uninstall?.(context(db, entry.plugin, hooks, ""))

  const migrations = resolve(`${dir}/${entry.plugin.name}/migrations`)
  if (existsSync(migrations)) await migrateDownAll(db, migrations, `plugin:${entry.plugin.name}`)

  await db.execute(
    from(contentTypes)
      .where(q => q("owner_plugin").equals(entry.plugin.name))
      .del(),
  )
  await db.execute(
    from(taxonomies)
      .where(q => q("owner_plugin").equals(entry.plugin.name))
      .del(),
  )
  await clearScope(db, entry.plugin.name)
  await db.execute(
    from(pluginsTable)
      .where(q => q("name").equals(entry.plugin.name))
      .del(),
  )

  hooks.removePlugin(entry.plugin.name)
}
