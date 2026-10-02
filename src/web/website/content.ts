import type { SharedPart } from "../../website/index.ts"
import { api, type Entry, type Field, type MenuItem } from "../api.ts"

export type SharedContent = {
  fields: Field[]
  values: Record<string, unknown>
  entry?: Entry
  menuExists?: boolean
  menuLabel?: string
}

export const loadPart = async (part: SharedPart): Promise<SharedContent> => {
  const source = part.source
  if (source.kind === "menu") {
    const menu = (await api.menus()).find(item => item.name === source.name)
    return {
      fields: [],
      values: { items: menu?.items ?? source.defaults ?? [] },
      menuExists: Boolean(menu),
      menuLabel: menu?.label ?? source.label,
    }
  }
  if (source.kind === "settings") {
    const settings = await api.settings()
    return { fields: settings.schema.filter(field => source.fields.includes(field.key)), values: settings.data }
  }
  const [type, entries] = await Promise.all([api.type(source.type), api.entries(source.type, { limit: 2 })])
  const entry = entries.data[0]
  if (type.kind !== "single" || entries.data.length !== 1 || !entry)
    throw new Error("These shared details need one existing entry. Ask the person who manages this site to connect it.")
  const fields = source.fields.map(key => {
    const field = type.fields.find(item => item.key === key)
    if (!field) throw new Error(`The editing control for ${key} is missing. Your content has not changed.`)
    return field
  })
  return { fields, values: entry.data, entry }
}

export const savePart = async (
  part: SharedPart,
  loaded: SharedContent,
  values: Record<string, unknown>,
): Promise<void> => {
  const source = part.source
  if (source.kind === "menu") {
    const items = values.items as MenuItem[]
    if (loaded.menuExists) await api.saveMenu(source.name, loaded.menuLabel ?? source.label, items)
    else await api.createMenu(source.label, items, source.name)
    return
  }
  const patch = Object.fromEntries(
    source.fields.filter(key => values[key] !== loaded.values[key]).map(key => [key, values[key]]),
  )
  if (source.kind === "settings") await api.saveSettings(patch)
  else if (loaded.entry) await api.updateEntry(loaded.entry.id, { data: patch })
  else throw new Error("These details could not be loaded. Reload before saving.")
}
