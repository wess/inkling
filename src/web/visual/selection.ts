export type Selection = { field?: string; section?: string; shared?: string }

export const selectionAt = (element: Element | null): Selection | null => {
  if (!element?.closest) return null
  const shared = element.closest("[data-inkling-shared]")?.getAttribute("data-inkling-shared") ?? undefined
  const field = element.closest("[data-inkling-field]")?.getAttribute("data-inkling-field") ?? undefined
  const section = element.closest("[data-inkling-section]")?.getAttribute("data-inkling-section") ?? undefined
  return shared || field || section ? { shared, field, section } : null
}

export const selectedElement = (doc: Document, selection: Selection): Element | undefined => {
  const attr = selection.shared
    ? "data-inkling-shared"
    : selection.field
      ? "data-inkling-field"
      : "data-inkling-section"
  const key = selection.shared ?? selection.field ?? selection.section
  return [...doc.querySelectorAll(`[${attr}]`)].find(element => element.getAttribute(attr) === key)
}

export const focusControl = (root: Element | null): void => {
  root?.scrollIntoView({ block: "nearest" })
  root
    ?.querySelector<HTMLElement>(
      "[data-media-pick], input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), [contenteditable=true]",
    )
    ?.focus({ preventScroll: true })
}
