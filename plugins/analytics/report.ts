import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { countRows, rows } from "../../src/db/dialect.ts"
import type { PluginStats } from "../../src/plugins/define.ts"
import { dayBefore, VIEW } from "./ingest.ts"

// Aggregation for the stats panel. Every query goes through `rows`/`countRows`
// from src/db/dialect.ts, because aggregates need Atlas's string-table form —
// `from(schema)` narrows .select() to the schema's own columns and would reject
// `COUNT(*) as total`.
//
// `.distinct()` is not used anywhere here: Atlas compiles it to Postgres's
// `DISTINCT ON`, which SQLite does not have. `COUNT(DISTINCT col)` is the
// spelling both dialects share.

const TOP = 10

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

// Days are UTC buckets, so the label has to be read back in UTC or the last
// day of a range renders as the one before it west of Greenwich.
const label = (day: string): string => DAY_LABEL.format(new Date(`${day}T12:00:00Z`))

const count = (value: number): string => value.toLocaleString("en-US")

const window = (since: string) => from("analytics_events", "a").where(q => q("a.day").greaterThanOrEqual(since))

const views = (since: string) => window(since).where(q => q("a.name").equals(VIEW))

const events = (since: string) => window(since).where(q => q("a.name").notEquals(VIEW))

// A quiet day is a data point, not a gap. Grouping only returns days that saw
// traffic, so the chart is filled back out to one column per day — otherwise a
// week with two busy days reads as continuous activity.
const fill = (since: string, days: number, counted: Map<string, number>): { label: string; value: number }[] => {
  const start = new Date(`${since}T00:00:00Z`).getTime()
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(start + index * 86_400_000).toISOString().slice(0, 10)
    return { label: label(day), value: counted.get(day) ?? 0 }
  })
}

export const summarize = async (db: Connection, days: number): Promise<PluginStats> => {
  // `days` is inclusive of today, so a 7-day window starts 6 days back.
  const since = dayBefore(days - 1)

  const [totalViews, visitors, totalEvents, daily, pages, referrers, named] = await Promise.all([
    countRows(db, views(since).select("COUNT(*) as total")),
    countRows(db, views(since).select("COUNT(DISTINCT a.visitor) as total")),
    countRows(db, events(since).select("COUNT(*) as total")),

    rows<{ day: string; total: number | string }>(
      db,
      views(since).select("a.day as day", "COUNT(*) as total").groupBy("a.day"),
    ),

    rows<{ path: string; total: number | string; people: number | string }>(
      db,
      views(since)
        .select("a.path as path", "COUNT(*) as total", "COUNT(DISTINCT a.visitor) as people")
        .groupBy("a.path")
        .orderBy("total", "DESC")
        .limit(TOP),
    ),

    rows<{ referrer: string; total: number | string }>(
      db,
      views(since)
        .select("a.referrer as referrer", "COUNT(*) as total")
        .groupBy("a.referrer")
        .orderBy("total", "DESC")
        .limit(TOP),
    ),

    rows<{ name: string; total: number | string; people: number | string }>(
      db,
      events(since)
        .select("a.name as name", "COUNT(*) as total", "COUNT(DISTINCT a.visitor) as people")
        .groupBy("a.name")
        .orderBy("total", "DESC")
        .limit(TOP),
    ),
  ])

  // COUNT is BIGINT on Postgres and may arrive as a string; countRows handles
  // that for scalars, and grouped rows need the same normalization.
  const counted = new Map(daily.map(row => [row.day, Number(row.total)]))
  const points = fill(since, days, counted)
  const busiest = points.reduce((best, point) => (point.value > best.value ? point : best), { label: "—", value: 0 })

  return {
    tiles: [
      { label: "Pageviews", value: count(totalViews) },
      { label: "Visitors", value: count(visitors), hint: "Unique per day, cookieless" },
      { label: "Events", value: count(totalEvents) },
      { label: "Busiest day", value: busiest.value === 0 ? "—" : busiest.label, hint: count(busiest.value) },
    ],
    series: { label: `Pageviews, last ${days} days`, points },
    tables: [
      {
        label: "Top pages",
        columns: [
          { key: "path", label: "Path" },
          { key: "views", label: "Views" },
          { key: "visitors", label: "Visitors" },
        ],
        rows: pages.map(row => ({
          path: row.path,
          views: count(Number(row.total)),
          visitors: count(Number(row.people)),
        })),
      },
      {
        label: "Referrers",
        columns: [
          { key: "source", label: "Source" },
          { key: "views", label: "Views" },
        ],
        // An empty referrer is someone typing the address or following a
        // bookmark. It is usually the largest bucket on a small site, so it is
        // shown rather than filtered out as "missing data".
        rows: referrers.map(row => ({ source: row.referrer || "Direct", views: count(Number(row.total)) })),
      },
      {
        label: "Events",
        columns: [
          { key: "event", label: "Event" },
          { key: "count", label: "Count" },
          { key: "visitors", label: "Visitors" },
        ],
        rows: named.map(row => ({
          event: row.name,
          count: count(Number(row.total)),
          visitors: count(Number(row.people)),
        })),
      },
    ],
  }
}
