import { expect, test } from "bun:test"
import { connect, from } from "@atlas/db"
import {
  cleanPath,
  cleanReferrer,
  dayOf,
  isBot,
  prune,
  readBeacon,
  record,
  resetPruneMemo,
  visitorKey,
} from "../plugins/analytics/ingest.ts"
import { summarize } from "../plugins/analytics/report.ts"
import { up } from "../src/migrate/index.ts"

const ready = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  await up(db, "./plugins/analytics/migrations", "plugin:analytics")
  return db
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()

// The insert path takes a Beacon; tests need to place rows on specific days,
// which `record` deliberately does not allow (it always stamps "now").
const seed = async (
  db: Awaited<ReturnType<typeof ready>>,
  row: { name: string; path: string; referrer?: string; visitor: string; iso: string },
) =>
  db.execute(
    from("analytics_events").insert({
      id: crypto.randomUUID(),
      name: row.name,
      path: row.path,
      referrer: row.referrer ?? "",
      visitor: row.visitor,
      meta: "{}",
      day: dayOf(row.iso),
      created_at: row.iso,
    }),
  )

test("a path is reduced to the part that identifies a page", () => {
  // Query strings carry campaign tags, session ids, and the occasional reset
  // token. None of it belongs in the table, and keeping it would scatter one
  // page across hundreds of rows.
  expect(cleanPath("/shop?utm_source=ig&token=secret")).toBe("/shop")
  expect(cleanPath("/blog/post#notes")).toBe("/blog/post")
  expect(cleanPath("https://example.com/visit?x=1")).toBe("/visit")
  expect(cleanPath("/shop/")).toBe("/shop")
  expect(cleanPath("/")).toBe("/")
  // Anything that is not a path at all is not a pageview.
  expect(cleanPath("javascript:alert(1)")).toBe("")
  expect(cleanPath(undefined)).toBe("")
})

test("a referrer keeps only its host, and internal navigation is not a source", () => {
  expect(cleanReferrer("https://www.google.com/search?q=coffee", [])).toBe("google.com")
  expect(cleanReferrer("https://theadvancedapothecary.com/shop", ["theadvancedapothecary.com"])).toBe("")
  expect(cleanReferrer("", [])).toBe("")
  expect(cleanReferrer("not a url", [])).toBe("")
})

test("an unnamed beacon is a pageview and a malformed event name does not become a column", () => {
  expect(readBeacon({ path: "/shop" }, [])?.name).toBe("view")
  expect(readBeacon({ path: "/shop", event: "AddToCart" }, [])?.name).toBe("addtocart")
  expect(readBeacon({ path: "/shop", event: "drop table--" }, [])?.name).toBe("view")
  expect(readBeacon({ event: "addtocart" }, [])).toBeNull()
})

test("meta is bounded in both key count and value length", () => {
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "x".repeat(1000)]))
  const meta = readBeacon({ path: "/shop", meta: wide }, [])?.meta ?? {}
  expect(Object.keys(meta).length).toBe(8)
  expect(Object.values(meta)[0]?.length).toBe(200)
})

// The whole privacy claim rests on this: the same person is countable today and
// uncorrelatable tomorrow, and nothing stored can be walked back to an address.
test("a visitor key is stable within a day and unrecognizable the next", async () => {
  const today = await visitorKey("2026-07-29", "203.0.113.7", "Firefox")
  const again = await visitorKey("2026-07-29", "203.0.113.7", "Firefox")
  const tomorrow = await visitorKey("2026-07-30", "203.0.113.7", "Firefox")

  expect(today).toBe(again)
  expect(today).not.toBe(tomorrow)
  expect(today).not.toContain("203.0.113.7")
})

test("obvious automated traffic is recognized", () => {
  expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true)
  expect(isBot("curl/8.4.0")).toBe(true)
  expect(isBot("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15")).toBe(false)
})

// The aggregation is the part most likely to break silently across dialects:
// it is the only place using GROUP BY and COUNT(DISTINCT). Postgres coverage
// rides along in tests/postgres.test.ts's shared migration path.
test("a summary counts views, uniques, and events over its window", async () => {
  const db = await ready()

  await seed(db, { name: "view", path: "/shop", visitor: "a", referrer: "google.com", iso: daysAgo(0) })
  await seed(db, { name: "view", path: "/shop", visitor: "a", referrer: "google.com", iso: daysAgo(0) })
  await seed(db, { name: "view", path: "/shop", visitor: "b", iso: daysAgo(1) })
  await seed(db, { name: "view", path: "/", visitor: "b", iso: daysAgo(1) })
  await seed(db, { name: "addtocart", path: "/shop", visitor: "a", iso: daysAgo(0) })
  // Outside a 7-day window, so it must not be counted below.
  await seed(db, { name: "view", path: "/shop", visitor: "c", iso: daysAgo(30) })

  const stats = await summarize(db, 7)
  const tile = (label: string) => stats.tiles.find(t => t.label === label)?.value

  expect(tile("Pageviews")).toBe("4")
  expect(tile("Visitors")).toBe("2")
  expect(tile("Events")).toBe("1")

  // One column per day in the window, quiet days included — otherwise a week
  // with two busy days would render as continuous activity.
  expect(stats.series?.points.length).toBe(7)
  // Today's two views. The event on the same day is not a pageview, so the
  // series does not count it.
  expect(stats.series?.points.at(-1)?.value).toBe(2)

  const pages = stats.tables?.find(t => t.label === "Top pages")
  expect(pages?.rows[0]).toEqual({ path: "/shop", views: "3", visitors: "2" })

  // A missing referrer is someone typing the address, which is a real answer
  // rather than absent data.
  const referrers = stats.tables?.find(t => t.label === "Referrers")
  expect(referrers?.rows.map(r => r.source).sort()).toEqual(["Direct", "google.com"])

  const events = stats.tables?.find(t => t.label === "Events")
  expect(events?.rows).toEqual([{ event: "addtocart", count: "1", visitors: "1" }])
})

test("a window with no traffic still returns a full row of tiles and a filled series", async () => {
  const db = await ready()
  const stats = await summarize(db, 30)

  expect(stats.tiles.map(t => t.value)).toEqual(["0", "0", "0", "—"])
  expect(stats.series?.points.length).toBe(30)
  expect(stats.tables?.every(table => table.rows.length === 0)).toBe(true)
})

test("retention deletes past the cutoff and runs once a day", async () => {
  const db = await ready()
  resetPruneMemo()

  await seed(db, { name: "view", path: "/", visitor: "a", iso: daysAgo(100) })
  await seed(db, { name: "view", path: "/", visitor: "a", iso: daysAgo(1) })

  const remaining = async () => (await db.all(from("analytics_events").select("id"))).length

  await prune(db, 90, "2026-07-29")
  expect(await remaining()).toBe(1)

  // Same day again: the memo short-circuits, so a second beacon does not pay
  // for a delete that already ran.
  await seed(db, { name: "view", path: "/", visitor: "a", iso: daysAgo(100) })
  await prune(db, 90, "2026-07-29")
  expect(await remaining()).toBe(2)

  // A new day sweeps again.
  await prune(db, 90, "2026-07-30")
  expect(await remaining()).toBe(1)
})

test("a beacon becomes exactly one row and never carries an address", async () => {
  const db = await ready()
  const beacon = readBeacon({ path: "/visit?utm=x", event: "formsubmit", referrer: "https://ig.com/" }, [])
  expect(beacon).not.toBeNull()

  await record(db, beacon as NonNullable<typeof beacon>, await visitorKey(dayOf(daysAgo(0)), "198.51.100.4", "Safari"))

  const row = await db.one<{ path: string; name: string; referrer: string; visitor: string }>(
    from("analytics_events").select("path", "name", "referrer", "visitor"),
  )
  expect(row?.path).toBe("/visit")
  expect(row?.name).toBe("formsubmit")
  expect(row?.referrer).toBe("ig.com")
  expect(row?.visitor).not.toContain("198.51.100.4")
})
