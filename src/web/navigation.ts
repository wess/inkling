import type { ContentType, VisualPage } from "./api.ts"

export const websiteNavigation = (types: ContentType[], visual: Record<string, VisualPage>) => {
  const labels = new Map<string, string>()
  for (const page of Object.values(visual)) {
    for (const section of page.sections) {
      if (section.collection) labels.set(section.collection.type, section.collection.label)
    }
  }
  const own = types.filter(type => !type.ownerPlugin)
  const configured = Object.keys(visual).length > 0
  const page = (type: ContentType) =>
    type.kind === "single" && Boolean(type.previewUrl) && (!configured || Object.hasOwn(visual, type.name))
  return {
    pages: own.filter(page).map(type => ({
      type,
      label: /^(front|home) page$/i.test(type.label) ? type.label : type.label.replace(/ page$/i, ""),
    })),
    content: own
      .filter(type => type.kind !== "single")
      .map(type => ({ type, label: labels.get(type.name) ?? type.pluralLabel })),
    shared: own.filter(type => type.kind === "single" && !page(type)).map(type => ({ type, label: type.label })),
  }
}
