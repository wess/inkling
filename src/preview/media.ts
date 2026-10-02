import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Field } from "../fields/index.ts"
import type { MediaRow } from "../media/index.ts"
import { present } from "../media/index.ts"
import { media } from "../schema/index.ts"

// References stay as ids: a preview token authorizes one entry, never the
// drafts that entry might reference. Nested media still needs expansion.
export const expandMedia = async (
  db: Connection,
  fields: readonly Field[],
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const ids = new Set<string>()
  const walk = (schema: readonly Field[], values: Record<string, unknown>, apply?: Map<string, MediaRow>) => {
    const result = { ...values }
    for (const field of schema) {
      const value = values[field.key]
      if (field.type === "media") {
        if (typeof value === "string") ids.add(value)
        const found = typeof value === "string" ? apply?.get(value) : undefined
        if (apply) result[field.key] = found ? present(found) : null
      } else if (field.type === "gallery" && Array.isArray(value)) {
        for (const id of value) if (typeof id === "string") ids.add(id)
        if (apply)
          result[field.key] = value.flatMap(id => {
            const found = typeof id === "string" ? apply.get(id) : undefined
            return found ? [present(found)] : []
          })
      } else if (field.type === "list" && field.fields && Array.isArray(value)) {
        const nested = field.fields
        result[field.key] = value.map(item =>
          typeof item === "object" && item !== null && !Array.isArray(item)
            ? walk(nested, item as Record<string, unknown>, apply)
            : item,
        )
      }
    }
    return result
  }
  walk(fields, data)
  const rows =
    ids.size === 0
      ? []
      : await db.all<MediaRow>(
          from(media)
            .where(q => q("id").inList([...ids]))
            .where(q => q("deleted_at").isNull()),
        )
  return walk(fields, data, new Map(rows.map(row => [row.id, row])))
}
