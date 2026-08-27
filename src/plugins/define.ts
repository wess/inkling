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
  // "secret" is a credential rather than a preference: it is sealed with the
  // same AES-GCM as every other stored key, it is never read back out of the
  // API, and the admin shows only its last four characters. A plugin asking for
  // one still reads plaintext from `getSetting` — see src/plugins/settings.ts.
  readonly type: "text" | "textarea" | "number" | "boolean" | "select" | "secret"
  readonly help?: string
  readonly default?: unknown
  readonly options?: readonly { value: string; label: string }[]
  // Shown under the field, for the value someone has to go and find somewhere
  // else. Longer than `help` and allowed to name buttons and screens.
  readonly find?: string
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
  // "connections" renders a PluginConnections payload from `endpoint`, with a
  // connect / reconnect / disconnect control per row.
  // "guide" renders a PluginGuide payload from `endpoint`: a walkthrough that
  // knows how far along it is.
  readonly kind: "settings" | "collection" | "table" | "stats" | "connections" | "guide"
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
  // Said above the numbers, when there is something to say about them —
  // usually that there are none yet and why. A dashboard that explains its own
  // emptiness is the difference between "this is broken" and "I have one step
  // left", and only the plugin knows which.
  readonly note?: string
  readonly tiles: readonly { label: string; value: string; hint?: string }[]
  readonly series?: { label: string; points: readonly { label: string; value: number }[] }
  readonly tables?: readonly {
    label: string
    columns: readonly { key: string; label: string }[]
    rows: readonly Record<string, string | number>[]
  }[]
}

// What a "connections" panel's endpoint returns under `data`. The SPA owns the
// three verbs and nothing else: it POSTs `<endpoint>/<id>/start` for a consent
// URL and sends the browser there, and DELETEs `<endpoint>/<connection id>` to
// disconnect. Everything a row *says* — whether an app is registered, what the
// account is called, why a connection went stale — is the plugin's to decide,
// because only the plugin knows what it is connecting to.
export type PluginConnections = {
  // Printed for the operator to paste into the provider's developer console. A
  // mismatch here is the most common reason one of these flows fails.
  readonly redirectUri?: string
  readonly connections: readonly {
    id: string
    label: string
    // False when no developer app is registered. The row explains itself
    // instead of offering a button that dead-ends.
    configured: boolean
    // What to do about that, in the plugin's own words. Without one the row
    // falls back to naming the SOCIAL_OAUTH_* variables, which is right for
    // social networks and wrong for everything else.
    hint?: string
    scopes?: readonly string[]
    connection: {
      id: string
      account: string | null
      expiresAt: string | null
      error: string | null
      connectedAt: string
    } | null
  }[]
}

// What a "guide" panel's endpoint returns under `data`. This is the screen for
// the person who did not build the site: plain words, numbered steps, each one
// knowing whether it is already behind them, and every value it asks for
// collected right there. Nobody is sent to another screen to paste something in
// and then sent back.
//
// A guide comes in parts because most setups have a cheap half and an expensive
// half, and presenting them as one list of eleven steps makes the cheap half
// look like it needs the expensive one. A part that is `optional` says so on
// screen and is not counted against "done".
//
// The SPA renders it and owns four verbs — follow a link, save an answer, pick
// from a list, and start a connection. Every word, every value, and the whole
// notion of what "done" means belongs to the plugin.
export type PluginGuideStep = {
  readonly title: string
  readonly body: string
  // Omitted for a step that is only instructions. Present makes it a checklist
  // row, so the screen can say what is left rather than repeating all of it.
  readonly done?: boolean
  // A value the step is telling someone to paste somewhere else, rendered as a
  // copyable block: a redirect URI, a tag snippet.
  readonly copy?: string
  readonly link?: { readonly label: string; readonly url: string }
  // A value the step is asking for. POSTs `{ value }` to `endpoint`, then
  // reloads the guide — so the step it belongs to can tick itself.
  readonly input?: {
    readonly endpoint: string
    readonly value?: string
    readonly placeholder?: string
    readonly action?: string
    // Renders masked and is never echoed back. For a plugin setting declared
    // `secret`, whose stored value cannot be read out again anyway.
    readonly secret?: boolean
  }
  // A question only the connected account can answer — which property, which
  // advertising account. POSTs `{ value }` to `endpoint` and reloads.
  readonly choices?: {
    readonly endpoint: string
    readonly selected?: string | null
    readonly empty?: string
    readonly options: readonly { value: string; label: string; hint?: string }[]
  }
  // Starts an OAuth connection from inside the guide, against the same endpoint
  // a "connections" panel would use — POST `<endpoint>/<id>/start` for a
  // consent URL, then a top-level navigation to it.
  readonly connect?: { readonly endpoint: string; readonly id: string; readonly label: string }
}

export type PluginGuidePart = {
  readonly title: string
  readonly summary?: string
  // Honest, including the part that is waiting rather than working.
  readonly time?: string
  // Shown as optional and left out of the completion count.
  readonly optional?: boolean
  readonly steps: readonly PluginGuideStep[]
}

export type PluginGuide = {
  // One sentence, in the words of someone who has not done this before.
  readonly summary: string
  readonly parts: readonly PluginGuidePart[]
  // The thing that goes wrong. One line each, and each one a real failure
  // somebody has hit rather than a general caution.
  readonly gotchas?: readonly string[]
}

export type PluginContext = {
  readonly db: Connection
  readonly name: string
  // Where the admin lives, without a trailing slash ("" when it is at the
  // root). A plugin needs this for exactly one thing: sending a browser back
  // into the admin after a top-level redirect it did not initiate, such as an
  // OAuth return leg. It is not the public URL and not a route prefix.
  readonly adminBase: string
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
