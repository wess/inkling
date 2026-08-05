import { from } from "atlas/db"
import { get, json, pipeline } from "atlas/server"
import { rows as query } from "../../src/db/dialect.ts"
import { cors } from "../../src/http/index.ts"
import { decodeObject } from "../../src/json/index.ts"
import { requireApiKey } from "../../src/keys/index.ts"
import { definePlugin } from "../../src/plugins/define.ts"

// A product catalog: content type, taxonomy, settings, and a convenience
// delivery route. Deliberately catalog-only — no cart, no checkout, no payment.
// Storefront behaviour belongs to the site; the CMS owns what a product *is*.

type ProductRow = { id: string; slug: string; title: string; data: string }

export default definePlugin({
  name: "commerce",
  version: "1.0.0",
  label: "Commerce",
  description: "A product catalog with categories, pricing, and availability.",
  author: "Inkling",

  settings: [
    {
      key: "currency",
      label: "Currency",
      type: "select",
      default: "USD",
      options: [
        { value: "USD", label: "US Dollar" },
        { value: "EUR", label: "Euro" },
        { value: "GBP", label: "Pound Sterling" },
        { value: "CAD", label: "Canadian Dollar" },
      ],
    },
    { key: "showOutOfStock", label: "List out-of-stock products", type: "boolean", default: true },
  ],

  taxonomies: [{ name: "productcategory", label: "Product categories", hierarchical: true }],

  contentTypes: [
    {
      name: "product",
      label: "Product",
      pluralLabel: "Products",
      description: "Something you sell.",
      icon: "shopping-bag",
      sortOrder: 20,
      fields: [
        { key: "tagline", type: "text", label: "Tagline", help: "One line under the name." },
        // The qualifier a shopper reads as part of the name — "40mg", "500ml",
        // "Large". Kept separate from the title so listings can style it.
        { key: "variant", type: "text", label: "Variant", help: "Size, strength, or format." },
        { key: "description", type: "textarea", label: "Description" },
        { key: "price", type: "number", label: "Price", min: 0, required: true },
        {
          key: "compareAtPrice",
          type: "number",
          label: "Compare-at price",
          min: 0,
          help: "Shown struck through when set.",
        },
        { key: "sku", type: "text", label: "SKU" },
        {
          key: "availability",
          type: "select",
          label: "Availability",
          default: "instock",
          options: [
            { value: "instock", label: "In stock" },
            { value: "lowstock", label: "Low stock" },
            { value: "outofstock", label: "Out of stock" },
            { value: "preorder", label: "Pre-order" },
          ],
        },
        { key: "image", type: "media", label: "Product image" },
        { key: "gallery", type: "gallery", label: "More images" },
        { key: "featured", type: "boolean", label: "Feature on the storefront", default: false },
        {
          key: "details",
          type: "list",
          label: "Details",
          help: "Spec rows shown on the product page.",
          fields: [
            { key: "label", type: "text", label: "Label", required: true },
            { key: "value", type: "text", label: "Value", required: true },
          ],
        },
      ],
    },
  ],

  panels: [
    { id: "products", label: "Products", icon: "shopping-bag", kind: "collection", contentType: "product" },
    { id: "commercesettings", label: "Commerce", icon: "settings", kind: "settings" },
  ],

  routes: ctx => [
    // Convenience over /content/product?featured=… — the delivery API filters
    // on columns, not on keys inside the JSON `data` blob.
    get(
      "/featured",
      pipeline(
        cors,
        requireApiKey(ctx.db),
      )(async c => {
        const limit = Math.min(Math.max(Number(c.query.limit) || 6, 1), 50)
        const showOutOfStock = await ctx.getSetting("showOutOfStock", true)
        const currency = await ctx.getSetting("currency", "USD")

        const rows = await query<ProductRow>(
          ctx.db,
          from("entries", "e")
            .join("content_types", "ct.id = e.content_type_id", "ct")
            .select("e.id", "e.slug", "e.title", "e.data")
            .where(q => q("ct.name").equals("product"))
            .where(q => q("e.status").equals("published"))
            .where(q => q("e.deleted_at").isNull())
            .orderBy("e.sort_order", "ASC")
            .limit(200),
        )

        const featured = rows
          .map(row => ({ ...row, parsed: decodeObject(row.data) }))
          .filter(row => row.parsed.featured === true)
          .filter(row => showOutOfStock || row.parsed.availability !== "outofstock")
          .slice(0, limit)
          .map(row => ({
            id: row.id,
            slug: row.slug,
            title: row.title,
            tagline: row.parsed.tagline ?? "",
            price: row.parsed.price ?? null,
            compareAtPrice: row.parsed.compareAtPrice ?? null,
            availability: row.parsed.availability ?? "instock",
          }))

        return json(c, 200, { data: featured, meta: { currency } })
      }),
    ),
  ],

  install: async ctx => {
    ctx.log("product type and productcategory taxonomy registered")
  },
})
