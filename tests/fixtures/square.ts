import type { CatalogObject } from "../../plugins/square/catalog.ts"
export const location = {
  id: "LOCATION",
  name: "Main shop",
  currency: "USD",
  status: "ACTIVE",
  capabilities: ["CREDIT_CARD_PROCESSING"],
}
export const item = (): CatalogObject => ({
  id: "ITEM",
  type: "ITEM",
  present_at_all_locations: true,
  item_data: {
    name: "Coffee mug",
    product_type: "REGULAR",
    variations: [
      {
        id: "VARIATION",
        type: "ITEM_VARIATION",
        present_at_all_locations: true,
        item_variation_data: {
          item_id: "ITEM",
          name: "Blue",
          pricing_type: "FIXED_PRICING",
          price_money: { amount: 1250, currency: "USD" },
          track_inventory: true,
        },
      },
    ],
  },
})
