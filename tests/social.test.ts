import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { tidyHashtags } from "../plugins/social/index.ts"
import { overLimit } from "../plugins/social/networks.ts"
import { buildQueue } from "../plugins/social/queue.ts"
import { summarize } from "../plugins/social/report.ts"
import { list, read, record } from "../plugins/social/results.ts"
import { week } from "../plugins/social/week.ts"
import { encode } from "../src/json/index.ts"
import { up } from "../src/migrate/index.ts"
import { now } from "../src/time/index.ts"

const ready = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  await up(db, "./plugins/social/migrations", "plugin:social")
  return db
}

type Db = Awaited<ReturnType<typeof ready>>

const type = async (db: Db, name: string): Promise<string> => {
  const id = crypto.randomUUID()
  await db.execute(
    from("content_types").insert({
      id,
      name,
      label: name,
      plural_label: name,
      kind: "collection",
      fields: "[]",
      sort_order: 0,
      owner_plugin: "social",
      created_at: now(),
      updated_at: now(),
    }),
  )
  return id
}

const entry = async (
  db: Db,
  typeId: string,
  title: string,
  data: Record<string, unknown>,
  status = "draft",
): Promise<string> => {
  const id = crypto.randomUUID()
  await db.execute(
    from("entries").insert({
      id,
      content_type_id: typeId,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      title,
      data: encode(data),
      status,
      locale: "en",
      sort_order: 0,
      created_at: now(),
      updated_at: now(),
    }),
  )
  return id
}

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString()

const dayAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

test("hashtags are normalized however they were typed", () => {
  expect(tidyHashtags("columbia sc, #smallbusiness  #SmallBusiness")).toBe("#columbia #sc #smallbusiness")
  expect(tidyHashtags("##doubled")).toBe("#doubled")
  expect(tidyHashtags("   ")).toBe("")
})

// The one mistake in a draft that is arithmetic rather than judgement.
test("a caption is flagged only against the networks it is going to", () => {
  const long = "x".repeat(400)
  expect(overLimit(["x", "instagram"], long)).toEqual(["X"])
  expect(overLimit(["instagram"], long)).toEqual([])
  expect(overLimit(["x", "threads"], "x".repeat(600))).toEqual(["X", "Threads"])
  expect(overLimit("not a list", long)).toEqual([])
})

test("results replace the same slot rather than accumulating", async () => {
  const db = await ready()
  const day = dayAgo(1)

  const first = read({ network: "instagram", day, postId: "post-1", impressions: 100, engagements: 5 })
  expect(first).not.toBeNull()
  await record(db, first as NonNullable<typeof first>)

  // The same day reported again a day later, as the numbers matured.
  const second = read({ network: "instagram", day, postId: "post-1", impressions: 180, engagements: 11 })
  await record(db, second as NonNullable<typeof second>)

  const rows = await list(db, { since: dayAgo(7), limit: 50 })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.impressions).toBe(180)

  // A different post on the same day and network is a different slot.
  const other = read({ network: "instagram", day, postId: "post-2", impressions: 20 })
  await record(db, other as NonNullable<typeof other>)
  expect(await list(db, { since: dayAgo(7), limit: 50 })).toHaveLength(2)
})

test("a broken integration cannot poison the totals", () => {
  const row = read({ network: "  INSTAGRAM ", impressions: -50, engagements: 3.6, clicks: "many", spend: 12.5 })
  expect(row?.network).toBe("instagram")
  expect(row?.impressions).toBe(0)
  expect(row?.engagements).toBe(4)
  expect(row?.clicks).toBe(0)
  expect(row?.spendCents).toBe(1_250)
  // A row with no network is not a measurement of anything.
  expect(read({ impressions: 10 })).toBeNull()
})

test("the queue orders by date and keeps undated posts in view", async () => {
  const db = await ready()
  const clients = await type(db, "socialclient")
  const posts = await type(db, "socialpost")
  const client = await entry(db, clients, "Palmetto Provisions", { postsPerWeek: 3, standing: "active" })

  await entry(db, posts, "Later", { client, stage: "scheduled", scheduledFor: inDays(5), caption: "hey" })
  await entry(db, posts, "Sooner", { client, stage: "approved", scheduledFor: inDays(1), caption: "hey" })
  await entry(db, posts, "Someday", { client, stage: "draft", caption: "hey" })
  await entry(db, posts, "Gone out", { client, stage: "posted", scheduledFor: inDays(-2), caption: "hey" })
  await entry(db, posts, "Way out", { client, stage: "draft", scheduledFor: inDays(400), caption: "hey" })

  const rows = await buildQueue(db, {
    timezone: "America/New_York",
    days: 21,
    leadTimeDays: 3,
    stages: ["idea", "draft", "review", "approved", "scheduled"],
  })

  // Posted work is not queue work, and a post 400 days out is a plan.
  expect(rows.map(row => row.title)).toEqual(["Sooner", "Later", "Someday"])
  expect(rows[0]?.client).toBe("Palmetto Provisions")
  expect(rows[2]?.when).toBe("Unscheduled")
})

test("the queue says what each post is waiting on", async () => {
  const db = await ready()
  const clients = await type(db, "socialclient")
  const posts = await type(db, "socialpost")
  const client = await entry(db, clients, "Client", {})

  await entry(db, posts, "In review", { client, stage: "review", scheduledFor: inDays(4), caption: "c" })
  await entry(db, posts, "Undated", { client, stage: "draft", caption: "c" })
  await entry(db, posts, "Tomorrow", { client, stage: "draft", scheduledFor: inDays(1), caption: "c" })
  await entry(db, posts, "Too long", {
    client,
    stage: "approved",
    scheduledFor: inDays(9),
    networks: ["x"],
    caption: "y".repeat(400),
  })

  const rows = await buildQueue(db, {
    timezone: "UTC",
    days: 30,
    leadTimeDays: 3,
    stages: ["idea", "draft", "review", "approved", "scheduled"],
  })
  const flags = Object.fromEntries(rows.map(row => [row.title, row.flag]))

  expect(flags.Tomorrow).toBe("Due in 1d, still drafting")
  expect(flags["In review"]).toBe("Waiting on approval")
  expect(flags.Undated).toBe("No date set")
  expect(flags["Too long"]).toBe("Too long for X")
})

test("the calendar leaves empty days in", async () => {
  const db = await ready()
  const clients = await type(db, "socialclient")
  const posts = await type(db, "socialpost")
  const client = await entry(db, clients, "Client", {})
  await entry(db, posts, "Tomorrow", { client, stage: "scheduled", scheduledFor: inDays(1), caption: "c" })

  const stats = await week(db, { timezone: "UTC", days: 7 })

  expect(stats.tables).toHaveLength(7)
  expect(stats.tiles[0]?.value).toBe("1")
  // Six of the seven days have nothing on them, and the panel has to say so.
  expect(stats.tiles[1]?.value).toBe("6")
})

test("the report measures cadence against what was sold", async () => {
  const db = await ready()
  const clients = await type(db, "socialclient")
  const posts = await type(db, "socialpost")
  const client = await entry(db, clients, "Palmetto Provisions", { postsPerWeek: 4, standing: "active" })

  // Four weeks at four a week is sixteen owed; eight went out.
  for (let index = 0; index < 8; index++) {
    await entry(db, posts, `Posted ${index}`, {
      client,
      stage: "posted",
      networks: ["instagram"],
      scheduledFor: inDays(-index - 1),
      caption: "c",
    })
  }
  await entry(db, posts, "Waiting", { client, stage: "review", scheduledFor: inDays(2), caption: "c" })

  const withoutNumbers = await summarize(db, 28)
  const tile = (label: string) => withoutNumbers.tiles.find(item => item.label === label)?.value

  expect(tile("Posted")).toBe("8")
  expect(tile("On pace")).toBe("50.0%")
  expect(tile("Awaiting approval")).toBe("1")
  // Nothing has been reported yet, so the series is the honest one.
  expect(withoutNumbers.series?.label).toBe("Posts published")

  const input = read({ network: "instagram", day: dayAgo(2), clientId: client, impressions: 4_000, engagements: 200 })
  await record(db, input as NonNullable<typeof input>)

  const withNumbers = await summarize(db, 28)
  expect(withNumbers.series?.label).toBe("Impressions")
  expect(withNumbers.tiles.find(item => item.label === "Reach")?.value).toBe("4,000")
  expect(withNumbers.tiles.find(item => item.label === "Engagement")?.value).toBe("5.0%")
})
