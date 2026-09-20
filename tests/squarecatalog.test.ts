import { expect, test } from "bun:test"
import { shippingAmount } from "../plugins/square/admin.ts"
import { inventory, listItems, variations } from "../plugins/square/catalog.ts"
import { cart } from "../plugins/square/store.ts"
import { item, location } from "./fixtures/square.ts"

const must = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing test fixture value")
  return value
}

test("location overrides determine sellability, stock tracking, and price", () => {
  const product = item()
  const detail = must(must(must(must(product.item_data).variations)[0]).item_variation_data)
  detail.location_overrides = [
    { location_id: "LOCATION", price_money: { amount: 999, currency: "USD" }, track_inventory: false },
  ]
  expect(variations(product, location)[0]).toMatchObject({ price: { amount: 999 }, tracked: false })
  must(detail.location_overrides[0]).sold_out = true
  expect(variations(product, location)[0]?.available).toBe(false)
  detail.measurement_unit_id = "WEIGHT"
  expect(variations(product, location)).toEqual([])
  delete detail.measurement_unit_id
  product.absent_at_location_ids = ["LOCATION"]
  expect(variations(product, location)).toEqual([])
})

test("catalog and inventory follow cursors without treating missing counts as in stock", async () => {
  let page = 0
  const list = await listItems((async () =>
    ++page === 1 ? { objects: [item()], cursor: "next" } : { objects: [{ ...item(), id: "SECOND" }] }) as any)
  expect(list).toHaveLength(2)
  const choices = variations(item(), location)
  let count = 0
  await inventory(
    (async () =>
      ++count === 1
        ? { counts: [], cursor: "next" }
        : {
            counts: [{ catalog_object_id: "VARIATION", location_id: "LOCATION", state: "IN_STOCK", quantity: "2" }],
          }) as any,
    location,
    choices,
  )
  expect(choices[0]?.stock).toBe(2)
  await inventory((async () => ({ counts: [] })) as any, location, choices)
  expect(choices[0]?.available).toBe(false)
})

test("cart and shipping reject fractional quantities and ambiguous amounts", () => {
  for (const quantity of [0, -1, 1.5, "2", 100, Infinity])
    expect(() => cart([{ productId: "p", variationId: "v", quantity }])).toThrow()
  expect(shippingAmount("5.25", "USD")).toBe(525)
  expect(shippingAmount("100", "JPY")).toBe(100)
  expect(() => shippingAmount("1.001", "USD")).toThrow()
  expect(() => shippingAmount("1.1", "JPY")).toThrow()
})
