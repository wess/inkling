import { definePlugin } from "../../src/plugins/define.ts"

// Demonstrates the `delivery.entry` filter: it adds a computed `seo` block to
// every entry the delivery API returns, without the core knowing SEO exists.
// Nothing is stored — the block is derived at read time from settings plus
// whatever fields the entry happens to have.

const firstString = (data: Record<string, unknown>, keys: readonly string[], limit: number): string => {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === "string" && value.trim() !== "") return truncate(stripHtml(value), limit)
  }
  return ""
}

const stripHtml = (value: string): string =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`

const applyTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "")

export default definePlugin({
  name: "seo",
  version: "1.0.0",
  label: "SEO",
  description: "Adds computed title, description, and social metadata to every delivered entry.",
  author: "Inkling",

  settings: [
    {
      key: "titleTemplate",
      label: "Title template",
      type: "text",
      default: "{title} — {siteTitle}",
      help: "Available placeholders: {title}, {siteTitle}, {type}",
    },
    {
      key: "descriptionFields",
      label: "Description source fields",
      type: "text",
      default: "excerpt,summary,description,intro,body",
      help: "Comma-separated field keys, tried in order, first non-empty wins.",
    },
    { key: "descriptionLength", label: "Description length", type: "number", default: 160 },
    { key: "imageField", label: "Social image field", type: "text", default: "image" },
    { key: "siteTitle", label: "Site title", type: "text", default: "" },
  ],

  panels: [
    {
      id: "seo",
      label: "SEO",
      icon: "search",
      kind: "settings",
      description: "Metadata generated for the delivery API.",
    },
  ],

  register: async ctx => {
    ctx.filter("delivery.entry", async ({ payload, type, raw }) => {
      const titleTemplate = await ctx.getSetting("titleTemplate", "{title} — {siteTitle}")
      const descriptionFields = await ctx.getSetting("descriptionFields", "excerpt,summary,description,intro,body")
      const descriptionLength = Number(await ctx.getSetting("descriptionLength", 160)) || 160
      const imageField = await ctx.getSetting("imageField", "image")
      const siteTitle = await ctx.getSetting("siteTitle", "")

      const data = (payload.data ?? {}) as Record<string, unknown>
      const keys = String(descriptionFields)
        .split(",")
        .map(k => k.trim())
        .filter(Boolean)

      // The delivery layer has already expanded media fields into objects, so
      // the social image is read from the expanded shape, not a raw id.
      const image = data[String(imageField)]
      const imageUrl =
        image && typeof image === "object" && "url" in image ? ((image as { url: string }).url ?? null) : null

      return {
        payload: {
          ...payload,
          seo: {
            title: applyTemplate(String(titleTemplate), {
              title: String(payload.title ?? ""),
              siteTitle: String(siteTitle),
              type: type.label,
            }).trim(),
            description: firstString(data, keys, descriptionLength),
            image: imageUrl,
            canonicalPath: `/${type.name}/${raw.slug}`,
          },
        },
        type,
        raw,
      }
    })
  },
})
