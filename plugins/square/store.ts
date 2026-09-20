import { badRequest, forbidden, get, json, parseJson, pipeline, post } from "atlas/server"
import { rows } from "../../src/db/dialect.ts"
import { body, noStore } from "../../src/http/index.ts"
import { keyAllows, keyIdentity, requireApiKey } from "../../src/keys/index.ts"
import type { PluginContext } from "../../src/plugins/define.ts"
import { createRateLimit } from "../../src/security/index.ts"
import { fetchItems, inventory, locationFor, variations } from "./catalog.ts"
import { settings } from "./config.ts"
import { connected, current } from "./connection.ts"
import type { ProductRow } from "./products.ts"
import { presentation, products } from "./products.ts"

export type CartLine = { productId: string; variationId: string; quantity: number }
export const cart = (value: unknown): CartLine[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50)
    throw badRequest("A cart must contain between 1 and 50 items")
  const merged = new Map<string, CartLine>()
  for (const line of value) {
    if (
      !line ||
      typeof line !== "object" ||
      Object.keys(line).some(key => !["productId", "variationId", "quantity"].includes(key)) ||
      typeof line.productId !== "string" ||
      !line.productId ||
      line.productId.length > 100 ||
      typeof line.variationId !== "string" ||
      !line.variationId ||
      line.variationId.length > 100 ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 99
    )
      throw badRequest("Choose a product, a variation, and a whole quantity between 1 and 99. Prices come from Square.")
    const key = `${line.productId}:${line.variationId}`
    const previous = merged.get(key)
    const quantity = (previous?.quantity ?? 0) + line.quantity
    if (quantity > 99) throw badRequest("You can buy up to 99 of one variation at a time")
    merged.set(key, { productId: line.productId, variationId: line.variationId, quantity })
  }
  return [...merged.values()]
}

export const storeRoutes = (ctx: PluginContext) => {
  const delivery = pipeline(noStore, requireApiKey(ctx.db), c => {
    if (!keyAllows(keyIdentity(c), "shopproduct")) throw forbidden("This key cannot access shop pages")
    return c
  })
  return [
    get(
      "/products",
      delivery(async c => {
        const page = Math.max(1, Math.min(100000, Math.floor(Number(c.query.page) || 1)))
        const limit = Math.max(1, Math.min(50, Math.floor(Number(c.query.limit) || 20)))
        const s = await settings(ctx)
        const { account, api } = await connected(ctx.db, s)
        const location = await locationFor(api, s.locationId)
        const found = await rows<ProductRow>(
          ctx.db,
          products(account)
            .limit(limit + 1)
            .offset((page - 1) * limit),
        )
        const selected = found.slice(0, limit)
        const catalog = await fetchItems(
          api,
          selected.map(row => row.item_id),
        )
        const data = selected.flatMap(row => {
          const item = catalog.find(item => item.id === row.item_id && item.type === "ITEM")
          const choices = item ? variations(item, location) : []
          if (!choices.length) return []
          const images = (item?.item_data?.image_ids ?? []).flatMap(id => {
            const url = catalog.find(image => image.id === id)?.image_data?.url
            return url?.startsWith("https://") ? [url] : []
          })
          return [{ ...presentation(row), squareItemId: row.item_id, squareImages: images, variations: choices }]
        })
        await inventory(
          api,
          location,
          data.flatMap(row => row.variations),
        )
        return json(c, 200, {
          data,
          meta: {
            page,
            limit,
            hasMore: found.length > limit,
            currency: location.currency,
            environment: s.environment,
            checkoutEnabled: s.checkoutEnabled,
          },
        })
      }),
    ),
    post(
      "/checkout",
      delivery(
        pipeline(parseJson)(async c => {
          const input = body(c)
          if (Object.keys(input).some(key => !["items", "idempotencyKey"].includes(key)))
            throw badRequest("Only items and idempotencyKey are accepted")
          const lines = cart(input.items)
          if (typeof input.idempotencyKey !== "string" || !/^[a-zA-Z0-9-]{16,100}$/.test(input.idempotencyKey))
            throw badRequest("Supply a unique idempotencyKey for this cart, and reuse it when retrying")
          const allowed = await createRateLimit(ctx.db).check(`square:checkout:${keyIdentity(c).id}`, 60, 60)
          if (!allowed.ok) return json(c, 429, { error: "The shop is busy. Please try again in a minute." })
          const s = await settings(ctx)
          if (!s.checkoutEnabled) throw badRequest("Checkout is paused", { code: "CHECKOUT_PAUSED" })
          const { account, api } = await connected(ctx.db, s)
          const location = await locationFor(api, s.locationId)
          const found: ProductRow[] = []
          for (const id of new Set(lines.map(line => line.productId))) {
            const [row] = await rows<ProductRow>(
              ctx.db,
              products(account)
                .where(q => q("e.id").equals(id))
                .limit(1),
            )
            if (!row) throw badRequest("A product is no longer available. Refresh your cart.")
            found.push(row)
          }
          const catalog = await fetchItems(
            api,
            found.map(row => row.item_id),
          )
          const choices = new Map(
            found.map(row => {
              const item = catalog.find(item => item.id === row.item_id && item.type === "ITEM")
              return [row.id, item ? variations(item, location) : []] as const
            }),
          )
          await inventory(api, location, [...choices.values()].flat())
          const totals = new Map<string, number>()
          const lineItems = lines.map(line => {
            const variation = choices.get(line.productId)?.find(item => item.id === line.variationId)
            const quantity = (totals.get(line.variationId) ?? 0) + line.quantity
            totals.set(line.variationId, quantity)
            if (!variation?.available || (variation.tracked && quantity > (variation.stock ?? 0)))
              throw badRequest("A product or quantity is no longer available. Refresh your cart.", {
                code: "OUT_OF_STOCK",
              })
            return { catalog_object_id: variation.id, quantity: String(line.quantity) }
          })
          const latest = await settings(ctx)
          if (
            (await current(ctx.db))?.id !== account.id ||
            !latest.checkoutEnabled ||
            latest.locationId !== s.locationId ||
            latest.shippingFee !== s.shippingFee
          )
            throw badRequest("The shop settings changed. Refresh your cart.")
          const idempotencyKey = new Bun.CryptoHasher("sha256")
            .update(`${s.environment}:${account.merchant_id}:${s.locationId}:${input.idempotencyKey}`)
            .digest("hex")
          const result = await api<{ payment_link?: { id: string; order_id: string; url: string } }>(
            "/v2/online-checkout/payment-links",
            {
              idempotency_key: idempotencyKey,
              order: {
                location_id: location.id,
                line_items: lineItems,
                pricing_options: { auto_apply_taxes: true, auto_apply_discounts: true },
              },
              checkout_options: {
                ask_for_shipping_address: true,
                ...(s.shippingFee
                  ? {
                      shipping_fee: {
                        name: "Shipping",
                        charge: { amount: s.shippingFee, currency: location.currency },
                      },
                    }
                  : {}),
              },
            },
          )
          const link = result.payment_link
          if (!link?.url || !link.order_id || !link.id || !link.url.startsWith("https://"))
            throw badRequest("Square did not return a checkout link. Retry with the same cart key.")
          return json(c, 200, { data: { url: link.url, orderId: link.order_id, environment: s.environment } })
        }),
      ),
    ),
  ]
}
