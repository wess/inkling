import { from } from "atlas/db"
import { can } from "../../auth/roles.ts"
import { decodeArray } from "../../json/index.ts"
import type { MenuItem } from "../../menus/index.ts"
import { safeUrl } from "../../menus/index.ts"
import { menus } from "../../schema/index.ts"
import { isSiteSetting, readScope, siteSettings } from "../../settings/index.ts"
import type { Tool } from "./common.ts"
import { fail, queued, record, text } from "./common.ts"

// The site as a whole rather than any one page: what it is called, how it is
// navigated, and which plugins are adding to it.

// Only the columns these tools read. `menus` does not export its row type, and
// widening to the whole table here would invite reading more than is needed.
type MenuRow = { name: string; label: string; items: string }

// Checked here as well as at apply time, so a link the write path would reject
// comes back while the model can still fix it — the person should never be
// handed a proposal that cannot be applied.
const badLink = (nodes: unknown[]): string | null => {
  for (const node of nodes) {
    const item = node as { label?: unknown; url?: unknown; children?: unknown }
    if (typeof item.url === "string" && item.url.trim() !== "" && !safeUrl(item.url.trim())) {
      return String(item.label ?? item.url)
    }
    if (Array.isArray(item.children)) {
      const nested = badLink(item.children)
      if (nested) return nested
    }
  }
  return null
}

const REJECTED_LINK = (offender: string) =>
  `"${offender}" has a link this site will not accept. Use a path starting with "/", or a full http, https, mailto, or tel URL.`

export const siteTools: readonly Tool[] = [
  {
    name: "get_site_settings",
    description:
      "Read the site-wide details: title, tagline, description, public URL, locale, timezone, and the media chosen as the logo, favicon, and default social image. Read this before proposing a change to any of them.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.readContent,
    run: async run => ({ output: await siteSettings(run.db) }),
  },

  {
    name: "list_menus",
    description:
      "List the site's navigation menus and the items in each, including nesting. Use it to find which menu someone means before changing it.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.readContent,
    run: async run => {
      const found = await run.db.all<MenuRow>(from(menus).select("name", "label", "items"))
      return {
        output: found.map(row => ({
          name: row.name,
          label: row.label,
          items: decodeArray<MenuItem>(row.items),
        })),
      }
    },
  },

  {
    name: "list_plugins",
    description:
      "List the plugins installed on this site: which are switched on, what each adds, and the settings it declares with their current values. A capability the site is missing is often a plugin that is simply off.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.managePlugins,
    run: async run => {
      const all = run.registry.all()
      const values = await Promise.all(all.map(entry => readScope(run.db, entry.plugin.name)))
      return {
        output: all.map((entry, index) => ({
          name: entry.plugin.name,
          label: entry.plugin.label ?? entry.plugin.name,
          description: entry.plugin.description ?? null,
          enabled: entry.enabled,
          error: entry.error ?? null,
          contentTypes: (entry.plugin.contentTypes ?? []).map(type => type.name),
          settings: (entry.plugin.settings ?? []).map(setting => ({
            key: setting.key,
            label: setting.label,
            type: setting.type,
            help: setting.help,
            options: setting.options,
            value: values[index]?.[setting.key] ?? setting.default ?? null,
          })),
        })),
      }
    },
  },

  {
    name: "propose_settings_update",
    description:
      "Propose a change to the site-wide details — renaming the site, rewriting its description, or choosing a different logo. Send only the keys you are changing. Media keys (logoId, faviconId, socialImageId) take an id from list_media, or null to clear.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line, for the person." },
        settings: {
          type: "object",
          description:
            "Only these keys: title, tagline, description, url, locale, timezone, logoId, faviconId, socialImageId.",
          additionalProperties: true,
        },
      },
      required: ["summary", "settings"],
      additionalProperties: false,
    },
    needs: can.manageSettings,
    run: async (run, input) => {
      const patch = record(input, "settings")
      const keys = Object.keys(patch)
      if (keys.length === 0) return fail("Nothing to change — send the settings you want to set.")

      // Rejected here rather than at apply time so the model can correct itself
      // while it still has the turn, instead of the person meeting the error.
      const unknown = keys.filter(key => !isSiteSetting(key))
      if (unknown.length > 0) {
        return fail(
          `Not a site setting: ${unknown.join(", ")}. Allowed: title, tagline, description, url, locale, timezone, logoId, faviconId, socialImageId.`,
        )
      }

      const current = await siteSettings(run.db)
      const before: Record<string, unknown> = {}
      for (const key of keys) before[key] = current[key] ?? null

      run.queue({
        kind: "settings.update",
        summary: text(input, "summary") || "Update the site details",
        patch,
        before,
      })

      return queued()
    },
  },

  {
    name: "propose_menu_update",
    description:
      "Propose a change to one navigation menu — adding a link, removing one, renaming, reordering, or nesting. Send the complete item list you want, not a partial one: it replaces what is there. Read the menu first with list_menus. An item that points at a page should carry that page's entryId rather than a hand-written url.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The menu's name, from list_menus." },
        summary: { type: "string", description: "One line, for the person." },
        label: { type: "string", description: "Optional new label for the menu itself." },
        items: {
          type: "array",
          description:
            "The complete ordered item list. Each item is { label, url? , entryId?, target?, children? } and children nest the same shape.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["name", "summary", "items"],
      additionalProperties: false,
    },
    needs: can.manageMenus,
    run: async (run, input) => {
      const menuName = text(input, "name")
      const row = await run.db.one<MenuRow>(
        from(menus)
          .select("name", "label", "items")
          .where(q => q("name").equals(menuName)),
      )
      if (!row) return fail(`No menu named "${menuName}". Call list_menus.`)
      if (!Array.isArray(input.items)) return fail("`items` must be the complete ordered array of menu items.")

      const offender = badLink(input.items)
      if (offender) return fail(REJECTED_LINK(offender))

      const patch: Record<string, unknown> = { items: input.items }
      if (text(input, "label")) patch.label = text(input, "label")

      run.queue({
        kind: "menu.update",
        summary: text(input, "summary") || `Update the ${row.label} menu`,
        menuName: row.name,
        menuLabel: row.label,
        patch,
        before: { label: row.label, items: decodeArray<MenuItem>(row.items) },
      })

      return queued()
    },
  },

  {
    name: "propose_menu_create",
    description:
      "Propose a brand new navigation menu — a footer, a sidebar, a second row. The site's own code decides where a menu appears, so say which name whoever built the site should read.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: 'As a person would say it, e.g. "Footer".' },
        summary: { type: "string", description: "One line, for the person." },
        items: {
          type: "array",
          description: "The ordered item list, same shape as propose_menu_update. May be empty.",
          items: { type: "object", additionalProperties: true },
        },
      },
      required: ["label", "summary"],
      additionalProperties: false,
    },
    needs: can.manageMenus,
    run: async (run, input) => {
      const label = text(input, "label")
      if (!label) return fail("A new menu needs a label.")
      const items = Array.isArray(input.items) ? input.items : []

      const offender = badLink(items)
      if (offender) return fail(REJECTED_LINK(offender))

      run.queue({
        kind: "menu.create",
        summary: text(input, "summary") || `Add a ${label} menu`,
        menuLabel: label,
        items,
      })

      return queued()
    },
  },

  {
    name: "propose_menu_delete",
    description:
      "Propose deleting a navigation menu outright. This is not recoverable and the site's code may still be asking for it by name, so say what will happen before you queue one — emptying a menu is usually what was meant.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The menu's name, from list_menus." },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["name", "summary"],
      additionalProperties: false,
    },
    needs: can.manageMenus,
    run: async (run, input) => {
      const row = await run.db.one<MenuRow>(
        from(menus)
          .select("name", "label", "items")
          .where(q => q("name").equals(text(input, "name"))),
      )
      if (!row) return fail(`No menu named "${text(input, "name")}". Call list_menus.`)

      run.queue({
        kind: "menu.delete",
        summary: text(input, "summary") || `Delete the ${row.label} menu`,
        menuName: row.name,
        menuLabel: row.label,
      })

      return queued()
    },
  },

  {
    name: "propose_plugin_state",
    description:
      "Propose switching a plugin on or off. Switching one on can add content types and screens; switching it off hides what it added without deleting anything. Call list_plugins first.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The plugin's name, from list_plugins." },
        enabled: { type: "boolean" },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["name", "enabled", "summary"],
      additionalProperties: false,
    },
    needs: can.managePlugins,
    run: async (run, input) => {
      const entry = run.registry.get(text(input, "name"))
      if (!entry) return fail(`No plugin named "${text(input, "name")}" is installed. Call list_plugins.`)
      const enabled = input.enabled === true
      if (entry.enabled === enabled) return fail(`"${entry.plugin.name}" is already ${enabled ? "on" : "off"}.`)
      if (enabled && entry.error) return fail(`"${entry.plugin.name}" failed to load: ${entry.error}`)

      run.queue({
        kind: "plugin.state",
        summary: text(input, "summary") || `Turn ${entry.plugin.label ?? entry.plugin.name} ${enabled ? "on" : "off"}`,
        pluginName: entry.plugin.name,
        pluginLabel: entry.plugin.label ?? entry.plugin.name,
        enabled,
      })

      return queued()
    },
  },

  {
    name: "propose_plugin_settings",
    description:
      "Propose new values for a plugin's settings. Only the keys the plugin declares are accepted — call list_plugins for those, and for what each one currently is. Send only the keys you are changing.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The plugin's name, from list_plugins." },
        settings: { type: "object", additionalProperties: true },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["name", "settings", "summary"],
      additionalProperties: false,
    },
    needs: can.managePlugins,
    run: async (run, input) => {
      const entry = run.registry.get(text(input, "name"))
      if (!entry) return fail(`No plugin named "${text(input, "name")}" is installed. Call list_plugins.`)

      const patch = record(input, "settings")
      const keys = Object.keys(patch)
      if (keys.length === 0) return fail("Nothing to change — send the settings you want to set.")

      const declared = new Set((entry.plugin.settings ?? []).map(setting => setting.key))
      const unknown = keys.filter(key => !declared.has(key))
      if (unknown.length > 0) {
        return fail(
          `"${entry.plugin.name}" does not have ${unknown.join(", ")}. It declares: ${[...declared].join(", ") || "nothing"}.`,
        )
      }

      const current = await readScope(run.db, entry.plugin.name)
      const before: Record<string, unknown> = {}
      for (const key of keys) before[key] = current[key] ?? null

      run.queue({
        kind: "plugin.settings",
        summary: text(input, "summary") || `Configure ${entry.plugin.label ?? entry.plugin.name}`,
        pluginName: entry.plugin.name,
        pluginLabel: entry.plugin.label ?? entry.plugin.name,
        patch,
        before,
      })

      return queued()
    },
  },
]
