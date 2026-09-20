import { badRequest } from "atlas/server"
import type { Client } from "./api.ts"

export type Money = { amount: number; currency: string }
type Override = {
  location_id: string
  price_money?: Money
  pricing_type?: string
  track_inventory?: boolean
  sold_out?: boolean
  sold_out_valid_until?: string
}
export type CatalogObject = {
  id: string
  type: string
  is_deleted?: boolean
  present_at_all_locations?: boolean
  present_at_location_ids?: string[]
  absent_at_location_ids?: string[]
  item_data?: {
    name?: string
    description_plaintext?: string
    is_archived?: boolean
    product_type?: string
    variations?: CatalogObject[]
    image_ids?: string[]
    modifier_list_info?: { enabled?: boolean }[]
  }
  item_variation_data?: {
    name?: string
    sku?: string
    item_id?: string
    pricing_type?: string
    price_money?: Money
    track_inventory?: boolean
    sellable?: boolean
    measurement_unit_id?: string
    stockable_conversion?: unknown
    location_overrides?: Override[]
  }
  image_data?: { url?: string }
}
export type Location = { id: string; name?: string; status: string; currency: string; capabilities?: string[] }
export type Variation = {
  id: string
  name: string
  sku: string
  price: Money
  tracked: boolean
  available: boolean
  stock: number | null
}

const present = (object: CatalogObject, locationId: string): boolean =>
  !object.is_deleted &&
  !object.absent_at_location_ids?.includes(locationId) &&
  (object.present_at_all_locations === true || object.present_at_location_ids?.includes(locationId) === true)

export const variations = (item: CatalogObject, location: Location): Variation[] => {
  const data = item.item_data
  if (
    !data ||
    !present(item, location.id) ||
    data.is_archived ||
    (data.product_type && data.product_type !== "REGULAR")
  )
    return []
  // Modifier selection, measured quantities, and stock conversions need their own cart UI.
  if (data.modifier_list_info?.some(info => info.enabled !== false)) return []
  return (data.variations ?? []).flatMap(variation => {
    const detail = variation.item_variation_data
    if (
      !detail ||
      !present(variation, location.id) ||
      detail.sellable === false ||
      detail.measurement_unit_id ||
      detail.stockable_conversion
    )
      return []
    const override = detail.location_overrides?.find(row => row.location_id === location.id)
    const money = override?.price_money ?? detail.price_money
    if (
      (override?.pricing_type ?? detail.pricing_type) !== "FIXED_PRICING" ||
      !money ||
      !Number.isSafeInteger(money.amount) ||
      money.amount < 0 ||
      money.currency !== location.currency
    )
      return []
    const soldOut =
      override?.sold_out === true &&
      (!override.sold_out_valid_until || Date.parse(override.sold_out_valid_until) > Date.now())
    return [
      {
        id: variation.id,
        name: detail.name ?? "Standard",
        sku: detail.sku ?? "",
        price: money,
        tracked: override?.track_inventory ?? detail.track_inventory ?? false,
        available: !soldOut,
        stock: null,
      },
    ]
  })
}

export const locations = async (api: Client): Promise<Location[]> => {
  const result = await api<{ locations?: Location[] }>("/v2/locations")
  return (result.locations ?? []).filter(
    row => row.status === "ACTIVE" && row.capabilities?.includes("CREDIT_CARD_PROCESSING"),
  )
}

export const locationFor = async (api: Client, id: string): Promise<Location> => {
  const location = (await locations(api)).find(row => row.id === id)
  if (!location) throw badRequest("Choose an active Square location that can accept card payments")
  return location
}

export const listItems = async (api: Client): Promise<CatalogObject[]> => {
  const items: CatalogObject[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const result = await api<{ objects?: CatalogObject[]; cursor?: string }>(
      `/v2/catalog/list?types=ITEM${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    )
    items.push(...(result.objects ?? []))
    cursor = result.cursor
    if (cursor && (seen.has(cursor) || seen.size >= 100))
      throw badRequest("This Square catalog is too large to load in one request")
    if (cursor) seen.add(cursor)
  } while (cursor)
  return items
}

export const fetchItems = async (api: Client, ids: string[]): Promise<CatalogObject[]> => {
  if (!ids.length) return []
  const result = await api<{ objects?: CatalogObject[]; related_objects?: CatalogObject[] }>(
    "/v2/catalog/batch-retrieve",
    { object_ids: [...new Set(ids)], include_related_objects: true },
  )
  return [...(result.objects ?? []), ...(result.related_objects ?? [])]
}

export const inventory = async (api: Client, location: Location, items: Variation[]): Promise<void> => {
  const ids = [...new Set(items.filter(item => item.tracked).map(item => item.id))]
  if (!ids.length) return
  const counts = new Map<string, number>()
  for (let start = 0; start < ids.length; start += 1000) {
    let cursor: string | undefined
    const seen = new Set<string>()
    do {
      const result = await api<{
        cursor?: string
        counts?: { catalog_object_id: string; location_id: string; state: string; quantity: string }[]
      }>("/v2/inventory/counts/batch-retrieve", {
        catalog_object_ids: ids.slice(start, start + 1000),
        location_ids: [location.id],
        states: ["IN_STOCK"],
        ...(cursor ? { cursor } : {}),
      })
      for (const count of result.counts ?? []) {
        if (count.location_id !== location.id || count.state !== "IN_STOCK" || counts.has(count.catalog_object_id))
          continue
        const amount = Number(count.quantity)
        counts.set(count.catalog_object_id, Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0)
      }
      cursor = result.cursor
      if (cursor && (seen.has(cursor) || seen.size >= 100))
        throw badRequest("Square returned an incomplete stock count. Try again.")
      if (cursor) seen.add(cursor)
    } while (cursor)
  }
  for (const item of items) {
    if (!item.tracked) continue
    item.stock = counts.get(item.id) ?? 0
    item.available = item.available && item.stock > 0
  }
}
