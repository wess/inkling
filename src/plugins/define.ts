import type { Connection } from "atlas/db"
import type { Route } from "atlas/server"
import type { Field } from "../fields/index.ts"
import type { EmitMap, EmitName, FilterMap, FilterName } from "./hooks.ts"

// A plugin is a plain object. `definePlugin` exists only to give the shape a
// name and get inference on hook payloads — there is no base class, no
// lifecycle inheritance, and nothing to extend.

export type PluginSetting = {
  readonly key: string
  readonly label: string
  readonly type: "text" | "textarea" | "number" | "boolean" | "select"
  readonly help?: string
  readonly default?: unknown
  readonly options?: readonly { value: string; label: string }[]
}

export type PluginContentType = {
  readonly name: string
  readonly label: string
  readonly pluralLabel?: string
  readonly description?: string
  readonly kind?: "collection" | "single"
  readonly previewUrl?: string
  readonly icon?: string
  readonly sortOrder?: number
  readonly fields: readonly Field[]
}

export type PluginTaxonomy = {
  readonly name: string
  readonly label: string
  readonly hierarchical?: boolean
}

// Plugin admin UI is declarative rather than shipped React. The SPA is bundled
// at build time, so a plugin cannot inject components into it; instead it
// describes panels the SPA already knows how to render. This keeps plugins
// installable without a rebuild, which is the whole point.
export type PluginPanel = {
  readonly id: string
  readonly label: string
  readonly icon?: string
  // "settings" renders the plugin's declared settings.
  // "collection" renders the CRUD table for one of its content types.
  // "table" renders rows fetched from `endpoint` using `columns`.
  // "stats" renders a PluginStats payload fetched from `endpoint`.
  readonly kind: "settings" | "collection" | "table" | "stats"
  readonly contentType?: string
  readonly endpoint?: string
  readonly columns?: readonly { key: string; label: string }[]
  // "stats" only: day windows offered as a range switch. The chosen one is
  // appended to `endpoint` as `?days=`.
  readonly ranges?: readonly number[]
  readonly description?: string
}

// What a "stats" panel's endpoint returns under `data`. The plugin does every
// bit of the shaping — aggregation, rounding, thousands separators — and the
// SPA only lays out what it is handed. That split is what lets a plugin ship a
// dashboard into a bundle that was built before the plugin existed.
export type PluginStats = {
  readonly tiles: readonly { label: string; value: string; hint?: string }[]
  readonly series?: { label: string; points: readonly { label: string; value: number }[] }
  readonly tables?: readonly {
    label: string
    columns: readonly { key: string; label: string }[]
    rows: readonly Record<string, string | number>[]
  }[]
}

export type PluginContext = {
  readonly db: Connection
  readonly name: string
  readonly on: <K extends EmitName>(name: K, fn: (payload: EmitMap[K]) => void | Promise<void>) => void
  readonly filter: <K extends FilterName>(
    name: K,
    fn: (payload: FilterMap[K]) => FilterMap[K] | Promise<FilterMap[K]>,
  ) => void
  // Settings are namespaced to the plugin; there is no way to read or write
  // another scope from here.
  readonly getSetting: <T>(key: string, fallback: T) => Promise<T>
  readonly setSetting: (key: string, value: unknown) => Promise<void>
  readonly allSettings: () => Promise<Record<string, unknown>>
  readonly log: (message: string) => void
}

export type Plugin = {
  readonly name: string
  readonly version: string
  readonly label?: string
  readonly description?: string
  readonly author?: string
  // Plugin names this one needs enabled first. Enabling resolves these in
  // dependency order; disabling refuses while a dependent is still on.
  readonly requires?: readonly string[]
  readonly contentTypes?: readonly PluginContentType[]
  readonly taxonomies?: readonly PluginTaxonomy[]
  readonly settings?: readonly PluginSetting[]
  readonly panels?: readonly PluginPanel[]
  // Mounted under /api/plugins/<name>/… — see src/plugins/index.ts.
  readonly routes?: (ctx: PluginContext) => Route[] | Promise<Route[]>
  readonly register?: (ctx: PluginContext) => void | Promise<void>
  // Runs once per version on enable/upgrade, after migrations.
  readonly install?: (ctx: PluginContext) => void | Promise<void>
  readonly uninstall?: (ctx: PluginContext) => void | Promise<void>
}

export const definePlugin = (plugin: Plugin): Plugin => plugin

const NAME = /^[a-z][a-z0-9]*$/

export const validatePlugin = (value: unknown): { ok: true; plugin: Plugin } | { ok: false; error: string } => {
  if (typeof value !== "object" || value === null) return { ok: false, error: "does not export a plugin object" }
  const plugin = value as Partial<Plugin>

  if (typeof plugin.name !== "string" || !NAME.test(plugin.name)) {
    return { ok: false, error: `name "${plugin.name}" must be lowercase letters and digits, starting with a letter` }
  }
  if (typeof plugin.version !== "string" || plugin.version.trim() === "") {
    return { ok: false, error: `plugin "${plugin.name}" is missing a version` }
  }
  for (const key of ["routes", "register", "install", "uninstall"] as const) {
    if (plugin[key] !== undefined && typeof plugin[key] !== "function") {
      return { ok: false, error: `plugin "${plugin.name}" has a non-function ${key}` }
    }
  }
  return { ok: true, plugin: plugin as Plugin }
}
