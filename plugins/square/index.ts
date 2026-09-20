import { definePlugin } from "../../src/plugins/define.ts"
import { adminRoutes } from "./admin.ts"
import { oauthRoutes } from "./oauth.ts"
import { storeRoutes } from "./store.ts"

export default definePlugin({
  name: "square",
  version: "1.0.0",
  label: "Square",
  description: "Connect your Square shop, publish product pages, and send shoppers to Square checkout.",
  requires: ["commerce"],
  settings: [
    {
      key: "locationId",
      label: "Square location",
      type: "text",
      default: "",
      help: "Choose this on Setup so Inkling can check the location.",
    },
    {
      key: "checkoutEnabled",
      label: "Allow checkout",
      type: "boolean",
      default: false,
      help: "Open checkout after testing your storefront and shipping settings.",
    },
    {
      key: "shippingFee",
      label: "Shipping fee (cents for USD)",
      type: "number",
      default: 0,
      help: "Use Setup to enter an ordinary amount such as 5.00. Zero means free shipping.",
    },
  ],
  panels: [
    { id: "setup", label: "Setup", icon: "store", kind: "guide", endpoint: "/ext/square/setup" },
    { id: "account", label: "Square account", icon: "key", kind: "connections", endpoint: "/ext/square/connections" },
    {
      id: "orders",
      label: "Recent orders",
      icon: "shopping-bag",
      kind: "table",
      endpoint: "/ext/square/orders",
      description:
        "The 100 most recent orders at this Square location, including sales from other channels. Order status is not proof of payment; use Square for payment details, refunds, and fulfillment.",
      columns: [
        { key: "id", label: "Order" },
        { key: "created", label: "Created" },
        { key: "status", label: "Order status" },
        { key: "total", label: "Total" },
      ],
    },
  ],
  routes: ctx => [...oauthRoutes(ctx), ...adminRoutes(ctx), ...storeRoutes(ctx)],
})
