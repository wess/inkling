import type { PluginStats } from "../../src/plugins/define.ts"
import { getJson, postJson } from "./api.ts"

// Reading GA4 back into Inkling, so the numbers are on the same screen as the
// thing that produced them. This is the optional half of the plugin: a site
// with a Measurement ID pasted in is already fully measured, and everything
// here only decides where somebody reads the result.

const DATA = "https://analyticsdata.googleapis.com/v1beta"
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta"

type Row = { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }
type Report = { rows?: Row[]; totals?: Row[] }

const cell = (row: Row | undefined, index: number): string => row?.metricValues?.[index]?.value ?? "0"
const label = (row: Row, index = 0): string => row.dimensionValues?.[index]?.value ?? ""

const count = (value: string): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export const thousands = (value: number): string => Math.round(value).toLocaleString("en-US")

// GA4 hands dates back as 20260827 with no separators, and a chart axis wants
// something a person can read at a glance.
export const readableDay = (compact: string): string => {
  if (!/^\d{8}$/.test(compact)) return compact
  const month = Number(compact.slice(4, 6))
  return `${compact.slice(6, 8)}/${month}`
}

const run = (property: string, token: string, body: unknown): Promise<Report> =>
  postJson(`${DATA}/properties/${property}:runReport`, token, body) as Promise<Report>

// Every GA4 account this token can see, and the web streams under each. Used
// twice: to offer the property list in the guide, and to fill in the
// Measurement ID afterwards so nobody has to go and find it a second time.
export type Property = { readonly id: string; readonly name: string; readonly account: string }

export const properties = async (token: string): Promise<Property[]> => {
  const payload = await getJson(`${ADMIN}/accountSummaries?pageSize=200`, token)
  const summaries = Array.isArray(payload.accountSummaries)
    ? (payload.accountSummaries as Record<string, unknown>[])
    : []

  return summaries.flatMap(summary => {
    const account = typeof summary.displayName === "string" ? summary.displayName : "Google Analytics"
    const list = Array.isArray(summary.propertySummaries)
      ? (summary.propertySummaries as Record<string, unknown>[])
      : []
    return list.map(item => ({
      id: String(item.property ?? "").replace("properties/", ""),
      name: typeof item.displayName === "string" ? item.displayName : String(item.property ?? ""),
      account,
    }))
  })
}

// The Measurement ID belonging to a property's first web stream. A property can
// hold app streams too, and those carry no G- id — which is exactly the case
// where somebody would otherwise paste an app stream's id and see nothing.
export const measurementIdFor = async (property: string, token: string): Promise<string> => {
  const payload = await getJson(`${ADMIN}/properties/${property}/dataStreams?pageSize=50`, token)
  const streams = Array.isArray(payload.dataStreams) ? (payload.dataStreams as Record<string, unknown>[]) : []

  for (const stream of streams) {
    const web = stream.webStreamData as Record<string, unknown> | undefined
    const id = typeof web?.measurementId === "string" ? web.measurementId : ""
    if (id) return id
  }
  return ""
}

export const summarize = async (property: string, token: string, days: number): Promise<PluginStats> => {
  const window = { startDate: `${days}daysAgo`, endDate: "today" }

  // Three calls rather than batchRunReports: one failing report should cost its
  // own card, not the whole dashboard, and the errors name themselves.
  const [daily, pages, channels] = await Promise.all([
    run(property, token, {
      dateRanges: [window],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 400,
    }),
    run(property, token, {
      dateRanges: [window],
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 10,
    }),
    run(property, token, {
      dateRanges: [window],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 8,
    }),
  ])

  const totals = daily.totals?.[0]
  const users = count(cell(totals, 0))
  const sessions = count(cell(totals, 1))
  const views = count(cell(totals, 2))

  return {
    tiles: [
      { label: "People", value: thousands(users), hint: `over the last ${days} days` },
      { label: "Visits", value: thousands(sessions) },
      { label: "Pages seen", value: thousands(views) },
      {
        label: "Pages per visit",
        value: sessions > 0 ? (views / sessions).toFixed(1) : "—",
      },
    ],
    series: {
      label: "People per day",
      points: (daily.rows ?? []).map(row => ({
        label: readableDay(label(row)),
        value: count(cell(row, 0)),
      })),
    },
    tables: [
      {
        label: "Most read",
        columns: [
          { key: "path", label: "Page" },
          { key: "views", label: "Views" },
        ],
        rows: (pages.rows ?? []).map(row => ({ path: label(row) || "/", views: thousands(count(cell(row, 0))) })),
      },
      {
        label: "How they arrived",
        columns: [
          { key: "channel", label: "Source" },
          { key: "sessions", label: "Visits" },
        ],
        rows: (channels.rows ?? []).map(row => ({
          channel: label(row) || "Unassigned",
          sessions: thousands(count(cell(row, 0))),
        })),
      },
    ],
  }
}
