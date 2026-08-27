import type { PluginStats } from "../../src/plugins/define.ts"
import { thousands } from "./analytics.ts"
import { getJson, postStream } from "./api.ts"

// Google Ads spend, on the same screen as the site it is spending on.
//
// This is the most expensive part of the plugin to switch on and it is worth
// saying why once, here: reading Ads needs a *developer token*, which is a
// separate thing from the OAuth app, is issued against a manager account, and
// starts life in a "test account only" state that returns nothing for a real
// account until Google approves it. Nothing in the code can shorten that, so
// the guide says it in advance instead of letting an empty dashboard imply a
// bug.

const HOST = "https://googleads.googleapis.com"

// Google Ads retires an API version roughly every four months. Pinning one and
// letting it rot would mean the plugin quietly stops working; the version is a
// setting so an operator can move it the week Google emails about it, and the
// error that says so is passed through verbatim.
const endpoint = (version: string, path: string): string => `${HOST}/${version}/${path}`

const headers = (developerToken: string, loginCustomerId: string): Record<string, string> => ({
  "developer-token": developerToken,
  ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
})

type Account = { readonly id: string; readonly name: string; readonly manager: boolean }

const field = (row: Record<string, unknown>, group: string, key: string): string => {
  const nested = row[group] as Record<string, unknown> | undefined
  const value = nested?.[key]
  return value === undefined || value === null ? "" : String(value)
}

const number = (value: string): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

// Ads reports money in millionths of the account currency, because a currency
// with more than two decimal places exists somewhere.
const money = (micros: string, currency: string): string => {
  const amount = number(micros) / 1_000_000
  try {
    return amount.toLocaleString("en-US", { style: "currency", currency: currency || "USD" })
  } catch {
    return `${amount.toFixed(2)} ${currency}`.trim()
  }
}

export const accessible = async (
  token: string,
  version: string,
  developerToken: string,
  loginCustomerId: string,
): Promise<Account[]> => {
  const payload = await getJson(
    endpoint(version, "customers:listAccessibleCustomers"),
    token,
    headers(developerToken, loginCustomerId),
  )
  const names = Array.isArray(payload.resourceNames) ? (payload.resourceNames as string[]) : []

  // Each id is asked to describe itself. A manager account answers and is
  // marked as one, because spend does not live on a manager and picking one is
  // the mistake this list exists to prevent.
  const described = await Promise.all(
    names.slice(0, 20).map(async name => {
      const id = name.replace("customers/", "")
      try {
        const rows = await postStream(
          endpoint(version, `customers/${id}/googleAds:search`),
          token,
          { query: "SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1" },
          headers(developerToken, loginCustomerId || id),
        )
        const row = rows[0] ?? {}
        return {
          id,
          name: field(row, "customer", "descriptiveName") || id,
          manager: field(row, "customer", "manager") === "true",
        }
      } catch {
        // An account that will not describe itself is still an account somebody
        // may want to pick, and refusing to list it would be worse than listing
        // it by its number.
        return { id, name: id, manager: false }
      }
    }),
  )

  return described
}

const search = (
  token: string,
  version: string,
  customerId: string,
  developerToken: string,
  loginCustomerId: string,
  query: string,
): Promise<Record<string, unknown>[]> =>
  postStream(
    endpoint(version, `customers/${customerId}/googleAds:searchStream`),
    token,
    { query },
    headers(developerToken, loginCustomerId),
  )

// GAQL takes literal dates rather than a relative window, and the account's own
// timezone decides what "today" is. Using the server's is close enough for a
// 7/30/90-day summary and avoids one more thing to configure.
const range = (days: number): { from: string; to: string } => {
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
  return { from: day(days), to: day(0) }
}

export const summarize = async (
  token: string,
  options: {
    readonly version: string
    readonly customerId: string
    readonly developerToken: string
    readonly loginCustomerId: string
    readonly days: number
  },
): Promise<PluginStats> => {
  const { from, to } = range(options.days)
  const where = `WHERE segments.date BETWEEN '${from}' AND '${to}'`
  const ask = (query: string) =>
    search(token, options.version, options.customerId, options.developerToken, options.loginCustomerId, query)

  const [totals, daily, campaigns] = await Promise.all([
    ask(
      `SELECT customer.currency_code, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM customer ${where}`,
    ),
    ask(`SELECT segments.date, metrics.clicks FROM customer ${where} ORDER BY segments.date ASC`),
    ask(
      `SELECT campaign.name, campaign.status, metrics.cost_micros, metrics.clicks, metrics.conversions FROM campaign ${where} ORDER BY metrics.cost_micros DESC LIMIT 10`,
    ),
  ])

  const total = totals[0] ?? {}
  const currency = field(total, "customer", "currencyCode") || "USD"
  const spend = number(field(total, "metrics", "costMicros"))
  const clicks = number(field(total, "metrics", "clicks"))
  const impressions = number(field(total, "metrics", "impressions"))
  const conversions = number(field(total, "metrics", "conversions"))

  return {
    tiles: [
      { label: "Spent", value: money(String(spend), currency), hint: `over the last ${options.days} days` },
      { label: "Clicks", value: thousands(clicks) },
      { label: "Shown", value: thousands(impressions), hint: "times an ad appeared" },
      {
        label: "Cost per click",
        value: clicks > 0 ? money(String(spend / clicks), currency) : "—",
      },
      { label: "Conversions", value: conversions > 0 ? conversions.toFixed(0) : "0" },
      {
        label: "Cost per conversion",
        value: conversions > 0 ? money(String(spend / conversions), currency) : "—",
      },
    ],
    series: {
      label: "Clicks per day",
      points: daily.map(row => {
        const date = field(row, "segments", "date")
        return {
          label: date.slice(8, 10).concat("/", String(Number(date.slice(5, 7)))),
          value: number(field(row, "metrics", "clicks")),
        }
      }),
    },
    tables: [
      {
        label: "Campaigns",
        columns: [
          { key: "name", label: "Campaign" },
          { key: "status", label: "Status" },
          { key: "spend", label: "Spent" },
          { key: "clicks", label: "Clicks" },
          { key: "conversions", label: "Conversions" },
        ],
        rows: campaigns.map(row => ({
          name: field(row, "campaign", "name") || "—",
          status: (field(row, "campaign", "status") || "").toLowerCase() || "—",
          spend: money(field(row, "metrics", "costMicros"), currency),
          clicks: thousands(number(field(row, "metrics", "clicks"))),
          conversions: number(field(row, "metrics", "conversions")).toFixed(0),
        })),
      },
    ],
  }
}
