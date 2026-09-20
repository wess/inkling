import type { PluginContentType } from "../../src/plugins/define.ts"

export const shopProduct: PluginContentType = {
  name: "shopproduct",
  label: "Shop page",
  pluralLabel: "Shop pages",
  description:
    "Add linked pages through Square → Setup, then edit your product stories and photos here. Prices and stock stay in Square.",
  icon: "shopping-bag",
  fields: [
    { key: "description", type: "richtext", label: "Product story" },
    { key: "image", type: "media", label: "Main photo" },
    { key: "gallery", type: "gallery", label: "More photos" },
    { key: "featured", type: "boolean", label: "Feature this product", default: false },
  ],
}

export const shop: PluginContentType = {
  name: "shop",
  label: "Shop introduction",
  kind: "single",
  icon: "store",
  fields: [
    { key: "introduction", type: "richtext", label: "Welcome message" },
    { key: "shipping", type: "richtext", label: "Shipping information" },
    { key: "returns", type: "richtext", label: "Returns information" },
    { key: "contact", type: "email", label: "Shop contact email" },
  ],
}
