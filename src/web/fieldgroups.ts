import type { Field } from "./api.ts"

export type FieldGroup = {
  name: string | null
  fields: { field: Field; label: string }[]
}

export const fieldGroups = (fields: Field[]): FieldGroup[] => {
  const groups: FieldGroup[] = []
  for (const field of fields) {
    const split = field.label.match(/^(.+?)\s+—\s+(.+)$/)
    const name = split?.[1] ?? null
    const last = groups.at(-1)
    if (!last || last.name !== name) groups.push({ name, fields: [] })
    groups.at(-1)?.fields.push({ field, label: split?.[2] ?? field.label })
  }
  return groups
}
