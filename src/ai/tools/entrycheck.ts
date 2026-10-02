import type { Connection } from "atlas/db"
import { isHttpError } from "atlas/server"
import type { ContentTypeRow } from "../../contenttypes/index.ts"
import { validateAgainstType, validateRelations } from "../../entries/index.ts"
import type { Field } from "../../fields/index.ts"
import { decodeArray } from "../../json/index.ts"
import type { VisualPage } from "../../visual/index.ts"
import { readLayout } from "../../visual/layout.ts"
import type { ToolResult } from "./common.ts"
import { fail } from "./common.ts"

// unknown keys are silently discarded by the form validator, but a proposed
// change must not advertise a value that will disappear when it is saved.
const unknownKeys = (fields: readonly Field[], data: Record<string, unknown>, prefix = ""): string[] => {
  const unknown: string[] = []
  for (const [key, value] of Object.entries(data)) {
    const field = fields.find(field => field.key === key)
    const path = `${prefix}${key}`
    if (!field) unknown.push(path)
    else if (field.type === "list" && field.fields?.length && Array.isArray(value)) {
      for (const [index, row] of value.entries()) {
        if (typeof row === "object" && row !== null && !Array.isArray(row)) {
          unknown.push(...unknownKeys(field.fields, row as Record<string, unknown>, `${path}[${index}].`))
        }
      }
    }
  }
  return unknown
}

export const checkEntryData = async (
  db: Connection,
  type: ContentTypeRow,
  data: Record<string, unknown>,
  existing: Record<string, unknown>,
  page?: VisualPage,
): Promise<ToolResult | null> => {
  const { __layout, ...values } = data
  const unknown = unknownKeys(decodeArray<Field>(type.fields), values)
  if (unknown.length) {
    return fail(
      `Unknown field keys: ${unknown.join(", ")}. Read get_entry or list_content_types and use their exact keys.`,
    )
  }

  try {
    if ("__layout" in data) {
      if (!page) return fail("This page has no visual sections to move or hide. Read get_page_layout first.")
      const layout = readLayout(__layout)
      const ids = new Set(page.sections.map(section => section.id))
      const unknown = [...new Set([...layout.order, ...layout.hidden])].filter(id => !ids.has(id))
      if (unknown.length)
        return fail(`Unknown visual sections: ${unknown.join(", ")}. Read get_page_layout for the section ids.`)
    }
    const validated = validateAgainstType(type, data, existing)
    await validateRelations(db, type, validated)
    return null
  } catch (error) {
    if (!isHttpError(error)) throw error
    const details = error.details as { fields?: { key: string; message: string }[] } | undefined
    const fields = details?.fields?.map(field => `${field.key}: ${field.message}`).join("; ")
    return fail(`${error.message}${fields ? `. ${fields}` : ""}. Correct the values before proposing this change.`)
  }
}
