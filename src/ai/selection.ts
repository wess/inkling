import type { VisualPages } from "../visual/index.ts"
import type { Website } from "../website/index.ts"

export type AgentSelection = {
  label: string
  shared?: string
  entryId?: string
  type?: string
  field?: string
  section?: string
}

export const selectionHint = (input: unknown, visual: VisualPages, website?: Website): string | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const selected = input as Record<string, unknown>
  if (typeof selected.shared === "string") {
    const part = website?.parts.find(part => part.id === selected.shared)
    return part
      ? `They selected the shared website part ${JSON.stringify({ label: part.label, source: part.source })}. This selection takes priority over the page behind it. Changes affect every page using this part. Read its saved source before proposing changes.`
      : null
  }
  if (typeof selected.type !== "string" || typeof selected.entryId !== "string" || selected.entryId.length > 100)
    return null
  const page = visual[selected.type]
  if (!page) return null
  const field =
    typeof selected.field === "string" &&
    (Object.hasOwn(page.fields ?? {}, selected.field) ||
      page.sections.some(section => section.fields.includes(selected.field as string)))
      ? selected.field
      : undefined
  const section = page.sections.find(section => section.id === selected.section)
  if (!field && !section) return null
  return `The editor reports this specific selection: ${JSON.stringify({ entryId: selected.entryId, type: selected.type, field, section: section?.id, sectionLabel: section?.label })}. Read that entry and verify its type before proposing changes. “This” means the selected field or section; preserve everything outside the requested change.`
}
