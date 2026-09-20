import { badRequest, get, json, parseJson, pipeline, post } from "atlas/server"
import { auth, requireAuth, requireCan } from "../../src/auth/guard.ts"
import { can } from "../../src/auth/roles.ts"
import { rows } from "../../src/db/dialect.ts"
import { body, noStore } from "../../src/http/index.ts"
import type { PluginContext, PluginGuide, PluginGuidePart } from "../../src/plugins/define.ts"
import { listItems, locationFor, locations, variations } from "./catalog.ts"
import { callback, configured, settings } from "./config.ts"
import { connected, current, matches } from "./connection.ts"
import { addProduct, type ProductRow, products } from "./products.ts"

const digits = (currency: string): number =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2
export const shippingAmount = (value: unknown, currency: string): number => {
  if (typeof value !== "string" || value.length > 14 || !/^\d+(?:\.\d+)?$/.test(value))
    throw badRequest("Enter a shipping amount, such as 5.00")
  const places = digits(currency)
  const [whole = "0", fraction = ""] = value.split(".")
  if (fraction.length > places) throw badRequest(`Use no more than ${places} decimal places for ${currency}`)
  const amount = Number(BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0") || "0"))
  if (!Number.isSafeInteger(amount)) throw badRequest("That shipping amount is too large")
  return amount
}

export const adminRoutes = (ctx: PluginContext) => {
  const admin = pipeline(noStore, requireAuth(ctx.db), requireCan(can.managePlugins, "manage the Square shop"))
  const write = pipeline(
    noStore,
    requireAuth(ctx.db),
    requireCan(can.managePlugins, "manage the Square shop"),
    parseJson,
  )
  return [
    get(
      "/setup",
      admin(async c => {
        const s = await settings(ctx)
        const row = await current(ctx.db)
        const valid = row && matches(row, s) && configured(s)
        const parts: PluginGuidePart[] = []
        const guide: PluginGuide = {
          summary: `Use Square for prices, stock, payments, and orders. Use Inkling for the pages shoppers see. ${s.environment === "sandbox" ? "This is a test shop. No real payments are taken." : "This shop uses your live Square account."}`,
          parts: parts,
          gotchas: [
            "Square items are private until you add a shop page and publish it in Inkling.",
            "This version supports whole-quantity products with fixed prices and shipping to an address. Products with modifiers, subscriptions, gift cards, and measured quantities need a different checkout.",
            "Stock is checked when checkout opens, but a checkout link does not reserve it. Check paid orders in Square before fulfilling them.",
            "Disconnecting stops new checkouts from Inkling. Previously created Square payment links remain in Square; close those there if needed.",
          ],
        }
        parts.push({
          title: "Connect your shop",
          steps: [
            {
              title: "Website setup",
              body: configured(s)
                ? "Your website manager has configured Square for this site."
                : "Ask your website manager to register a Square application and set its application ID and secret on this site. Customers only need to connect their own Square account after that.",
              done: configured(s),
              ...(!configured(s)
                ? {
                    copy: callback(),
                    link: { label: "Setup instructions", url: "https://wess.io/inkling/commerce.md" },
                  }
                : {}),
            },
            {
              title: "Connect your Square account",
              body: valid
                ? `Connected to shop ${row.merchant_id}. To change accounts or disconnect, open Square account.`
                : "Sign in to Square and allow Inkling to read your products and create checkouts. Your Square password stays with Square.",
              done: Boolean(valid),
              ...(configured(s)
                ? {
                    connect: {
                      endpoint: "/ext/square/connections",
                      id: "square",
                      label: valid ? "Reconnect Square" : "Connect Square",
                    },
                  }
                : {}),
            },
          ],
        })
        if (valid) {
          try {
            const { account, api } = await connected(ctx.db, s)
            const allLocations = await locations(api)
            const location = allLocations.find(row => row.id === s.locationId)
            parts.push({
              title: "Choose where you sell",
              steps: [
                {
                  title: "Square location",
                  body: "Choose the location whose prices and stock this shop should use. Changing it pauses checkout.",
                  done: Boolean(location),
                  choices: {
                    endpoint: "/ext/square/setup/location",
                    selected: s.locationId,
                    empty: "Square has no active location ready for card payments.",
                    options: allLocations.map(row => ({
                      value: row.id,
                      label: row.name ?? row.id,
                      hint: row.currency,
                    })),
                  },
                },
              ],
            })
            if (location) {
              const existing = await rows<ProductRow>(ctx.db, products(account, false))
              const items = (await listItems(api)).filter(
                item => variations(item, location).length > 0 && !existing.some(row => row.item_id === item.id),
              )
              parts.push({
                title: "Choose products for your website",
                steps: [
                  {
                    title: "Add a shop page",
                    body: "Choose a Square product to create its draft page. Adding a page does not change the product in Square. Repeat for the products you want online.",
                    choices: {
                      endpoint: "/ext/square/setup/product",
                      empty:
                        "No more supported products to add. Add fixed-price products in Square, or edit your existing shop pages.",
                      options: items.map(item => ({ value: item.id, label: item.item_data?.name ?? item.id })),
                    },
                  },
                  {
                    title: "Write and publish your pages",
                    body: "Open a shop page, add your story and photos, and publish it when ready. Prices and stock stay in Square. A page created outside this setup has no Square link and cannot be bought.",
                    done: existing.some(row => row.status === "published"),
                    link: { label: "Open shop pages", url: `${ctx.adminBase}/c/shopproduct` },
                  },
                ],
              })
              parts.push({
                title: "Prepare checkout",
                steps: [
                  {
                    title: `Shipping charge (${location.currency})`,
                    body: "One flat shipping charge per cart. Enter 0 for free shipping. This does not calculate carrier rates or restrict delivery countries; make your shipping policy clear before opening the shop.",
                    input: {
                      endpoint: "/ext/square/setup/shipping",
                      value: (s.shippingFee / 10 ** digits(location.currency)).toFixed(digits(location.currency)),
                      action: "Save shipping charge",
                    },
                  },
                  {
                    title: "Open checkout",
                    body: "Have your website manager connect the product list and cart to your site. Check shipping and the taxes configured in Square, complete a test checkout, then open checkout. Refunds and fulfillment stay in Square.",
                    done: s.checkoutEnabled,
                    choices: {
                      endpoint: "/ext/square/setup/checkout",
                      selected: String(s.checkoutEnabled),
                      options: [
                        { value: "false", label: "Paused" },
                        {
                          value: "true",
                          label: s.environment === "sandbox" ? "Open test checkout" : "Open live checkout",
                        },
                      ],
                    },
                  },
                ],
              })
            }
          } catch {
            parts.push({
              title: "Square needs attention",
              steps: [
                {
                  title: "Check the connection",
                  body: "Square could not load this shop. Reconnect if permissions were removed, or try again after a temporary Square outage.",
                },
              ],
            })
          }
        }
        return json(c, 200, { data: guide })
      }),
    ),
    post(
      "/setup/:step",
      write(async c => {
        const s = await settings(ctx)
        const { account, api } = await connected(ctx.db, s)
        const value = body(c).value
        const step = c.params.step
        if (step === "location") {
          if (typeof value !== "string") throw badRequest("Choose a location")
          await locationFor(api, value)
          await ctx.setSetting("checkoutEnabled", false)
          await ctx.setSetting("locationId", value)
          return json(c, 200, { data: { saved: true } })
        }
        const location = await locationFor(api, s.locationId)
        if (step === "product") {
          const item = (await listItems(api)).find(item => item.id === value)
          if (!item || !variations(item, location).length)
            throw badRequest("Choose a supported Square product at this location")
          const id = await addProduct(ctx.db, account, item, auth(c).id)
          return json(c, 200, { data: { id } })
        }
        if (step === "shipping") {
          await ctx.setSetting("shippingFee", shippingAmount(value, location.currency))
        } else if (step === "checkout" && (value === "true" || value === "false")) {
          await ctx.setSetting("checkoutEnabled", value === "true")
        } else throw badRequest("Choose a valid shop setting")
        return json(c, 200, { data: { saved: true } })
      }),
    ),
    get(
      "/orders",
      admin(async c => {
        const s = await settings(ctx)
        const { api } = await connected(ctx.db, s)
        await locationFor(api, s.locationId)
        const result = await api<{
          orders?: {
            id: string
            state: string
            created_at: string
            total_money?: { amount: number; currency: string }
          }[]
          cursor?: string
        }>("/v2/orders/search", {
          location_ids: [s.locationId],
          limit: 100,
          query: { sort: { sort_field: "CREATED_AT", sort_order: "DESC" } },
        })
        return json(c, 200, {
          data: (result.orders ?? []).map(order => ({
            id: order.id,
            status: order.state,
            created: order.created_at,
            total: order.total_money
              ? new Intl.NumberFormat("en", { style: "currency", currency: order.total_money.currency }).format(
                  order.total_money.amount / 10 ** digits(order.total_money.currency),
                )
              : "",
          })),
          meta: { hasMore: Boolean(result.cursor) },
        })
      }),
    ),
  ]
}
