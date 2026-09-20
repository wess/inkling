import { badRequest } from "atlas/server"
import { config } from "../../src/config/index.ts"
import type { PluginContext } from "../../src/plugins/define.ts"

export const VERSION = "2026-09-16"
export const SCOPES = [
  "MERCHANT_PROFILE_READ",
  "ITEMS_READ",
  "INVENTORY_READ",
  "ORDERS_READ",
  "ORDERS_WRITE",
  "PAYMENTS_WRITE",
]
export type Settings = {
  environment: "sandbox" | "production"
  clientId: string
  clientSecret: string
  locationId: string
  checkoutEnabled: boolean
  shippingFee: number
}

export const settings = async (ctx: PluginContext): Promise<Settings> => {
  const environment = Bun.env.SQUARE_ENVIRONMENT || "sandbox"
  if (environment !== "sandbox" && environment !== "production")
    throw badRequest("SQUARE_ENVIRONMENT must be sandbox or production")
  const location = await ctx.getSetting("locationId", "")
  const fee = await ctx.getSetting("shippingFee", 0)
  if (!Number.isSafeInteger(fee) || fee < 0)
    throw badRequest("Shipping fee must be a whole number of currency units, such as cents")
  return {
    environment,
    clientId: Bun.env.SQUARE_APPLICATION_ID || "",
    clientSecret: Bun.env.SQUARE_APPLICATION_SECRET || "",
    locationId: typeof location === "string" ? location : "",
    checkoutEnabled: (await ctx.getSetting("checkoutEnabled", false)) === true,
    shippingFee: fee,
  }
}

export const host = (s: Pick<Settings, "environment">): string =>
  s.environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com"

export const callback = (): string => `${config.publicUrl.replace(/\/$/, "")}/ext/square/callback`

export const configured = (s: Settings): boolean => Boolean(s.clientId && s.clientSecret)

export const checkCallback = (s: Settings): void => {
  const url = new URL(callback())
  if (
    url.protocol !== "https:" &&
    !(s.environment === "sandbox" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw badRequest("Set PUBLIC_URL to this site's HTTPS address before connecting Square")
  }
}
