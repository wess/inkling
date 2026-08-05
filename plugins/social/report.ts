import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { rows as query } from "../../src/db/dialect.ts"
import type { PluginStats } from "../../src/plugins/define.ts"
import { byId, loadType, num, refId, text } from "./entries.ts"
import { OPEN_STAGES, STAGE_LABELS, STAGES } from "./model.ts"
import { networkLabel } from "./networks.ts"

// The report behind the "Performance" panel. Two sources, deliberately: the
// posts say what was *made*, `social_results` says what it *did*. A dashboard
// that only had the second would go blank for a month with no numbers typed in,
// which is exactly the month you most want to see the cadence.
//
// Every aggregate goes through the string-table form and `rows` — see
// src/db/dialect.ts — and none of them use `.distinct()`, which Atlas compiles
// to Postgres-only syntax.

const DAY = 86_400_000

const dayBefore = (days: number): string => new Date(Date.now() - days * DAY).toISOString().slice(0, 10)

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

const label = (day: string): string => DAY_LABEL.format(new Date(`${day}T12:00:00Z`))

const whole = (value: number): string => Math.round(value).toLocaleString("en-US")

// Big numbers in a small tile. 12,400 reads as 12.4k faster than it reads as
// itself, and nothing here turns on the last two digits.
const compact = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 10_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return whole(value)
}

const percent = (part: number, total: number): string => (total === 0 ? "—" : `${((part / total) * 100).toFixed(1)}%`)

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0, minimumFractionDigits: 0 })}`

type Totals = { impressions: number; engagements: number; clicks: number; follows: number; spend: number }

const zero = (): Totals => ({ impressions: 0, engagements: 0, clicks: 0, follows: 0, spend: 0 })

const add = (
  into: Totals,
  row: { impressions: unknown; engagements: unknown; clicks: unknown; follows: unknown; spend_cents: unknown },
): void => {
  into.impressions += num(row.impressions)
  into.engagements += num(row.engagements)
  into.clicks += num(row.clicks)
  into.follows += num(row.follows)
  into.spend += num(row.spend_cents)
}

type ResultSlice = {
  network: string
  day: string
  post_id: string | null
  client_id: string | null
  impressions: number
  engagements: number
  clicks: number
  follows: number
  spend_cents: number
}

const fill = (since: string, days: number, counted: Map<string, number>): { label: string; value: number }[] => {
  const start = new Date(`${since}T00:00:00Z`).getTime()
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(start + index * DAY).toISOString().slice(0, 10)
    return { label: label(day), value: counted.get(day) ?? 0 }
  })
}

export const summarize = async (db: Connection, days: number): Promise<PluginStats> => {
  // `days` includes today, so a 30-day window starts 29 days back.
  const since = dayBefore(days - 1)
  const now = Date.now()
  const windowStart = now - (days - 1) * DAY

  const [results, posts, clients] = await Promise.all([
    query<ResultSlice>(
      db,
      from("social_results", "r")
        .select(
          "r.network",
          "r.day",
          "r.post_id",
          "r.client_id",
          "r.impressions",
          "r.engagements",
          "r.clicks",
          "r.follows",
          "r.spend_cents",
        )
        .where(q => q("r.day").greaterThanOrEqual(since))
        .limit(20_000),
    ),
    loadType(db, "socialpost"),
    loadType(db, "socialclient"),
  ])

  const clientsById = byId(clients)

  const dated = posts.map(post => {
    const scheduled = text(post.data.scheduledFor)
    const at = scheduled ? new Date(scheduled).getTime() : Number.NaN
    return {
      post,
      at: Number.isFinite(at) ? at : null,
      stage: text(post.data.stage) || "draft",
      clientId: refId(post.data.client),
      networks: Array.isArray(post.data.networks) ? post.data.networks.map(String) : [],
    }
  })

  const postedInWindow = dated.filter(
    row => row.stage === "posted" && row.at !== null && row.at >= windowStart && row.at <= now,
  )
  const scheduledAhead = dated.filter(row => row.stage === "scheduled" && row.at !== null && row.at > now)
  const awaiting = dated.filter(row => row.stage === "review")
  const overdue = dated.filter(
    row => OPEN_STAGES.includes(row.stage) && row.stage !== "idea" && row.at !== null && row.at < now,
  )

  const totals = zero()
  for (const row of results) add(totals, row)

  // Cadence: what the active clients are owed over this window against what
  // actually went out. The number people argue about at the end of a month.
  const activeClients = clients.filter(client => (text(client.data.standing) || "active") === "active")
  const weeks = days / 7
  const owed = activeClients.reduce((sum, client) => sum + num(client.data.postsPerWeek) * weeks, 0)

  const perDay = new Map<string, number>()
  for (const row of results) perDay.set(row.day, (perDay.get(row.day) ?? 0) + num(row.impressions))

  const postsPerDay = new Map<string, number>()
  for (const row of postedInWindow) {
    if (row.at === null) continue
    const day = new Date(row.at).toISOString().slice(0, 10)
    postsPerDay.set(day, (postsPerDay.get(day) ?? 0) + 1)
  }

  const hasResults = results.length > 0

  const tiles = [
    { label: "Posted", value: whole(postedInWindow.length), hint: `in the last ${days} days` },
    {
      label: "On pace",
      value: owed === 0 ? "—" : percent(postedInWindow.length, owed),
      hint: owed === 0 ? "no cadence set" : `${whole(owed)} owed across ${activeClients.length} active`,
    },
    { label: "Scheduled", value: whole(scheduledAhead.length), hint: "still to go out" },
    {
      label: "Awaiting approval",
      value: whole(awaiting.length),
      hint: overdue.length > 0 ? `${overdue.length} past their date` : "nothing overdue",
    },
    {
      label: "Reach",
      value: compact(totals.impressions),
      hint: hasResults ? "impressions" : "no results recorded yet",
    },
    {
      label: "Engagement",
      value: percent(totals.engagements, totals.impressions),
      hint: `${compact(totals.engagements)} interactions`,
    },
    { label: "New followers", value: compact(totals.follows), hint: "across every channel" },
    { label: "Ad spend", value: totals.spend === 0 ? "—" : money(totals.spend), hint: "recorded against posts" },
  ]

  // Counting posts is the honest series until somebody types in a number;
  // impressions are the one worth looking at once they have.
  const series = hasResults
    ? { label: "Impressions", points: fill(since, days, perDay) }
    : { label: "Posts published", points: fill(since, days, postsPerDay) }

  const byNetwork = new Map<string, Totals & { posts: number }>()
  for (const row of results) {
    const bucket = byNetwork.get(row.network) ?? { ...zero(), posts: 0 }
    add(bucket, row)
    byNetwork.set(row.network, bucket)
  }
  for (const row of postedInWindow) {
    for (const network of row.networks) {
      const bucket = byNetwork.get(network) ?? { ...zero(), posts: 0 }
      bucket.posts += 1
      byNetwork.set(network, bucket)
    }
  }

  const networkRows = [...byNetwork.entries()]
    .sort((a, b) => b[1].impressions - a[1].impressions || b[1].posts - a[1].posts)
    .map(([network, bucket]) => ({
      network: networkLabel(network),
      posts: bucket.posts,
      impressions: compact(bucket.impressions),
      engagements: compact(bucket.engagements),
      rate: percent(bucket.engagements, bucket.impressions),
    }))

  const byClient = new Map<string, { posts: number; totals: Totals }>()
  for (const row of postedInWindow) {
    if (!row.clientId) continue
    const bucket = byClient.get(row.clientId) ?? { posts: 0, totals: zero() }
    bucket.posts += 1
    byClient.set(row.clientId, bucket)
  }
  for (const row of results) {
    if (!row.client_id) continue
    const bucket = byClient.get(row.client_id) ?? { posts: 0, totals: zero() }
    add(bucket.totals, row)
    byClient.set(row.client_id, bucket)
  }

  const clientRows = [...byClient.entries()]
    .map(([clientId, bucket]) => {
      const client = clientsById.get(clientId)
      const target = num(client?.data.postsPerWeek) * weeks
      return {
        client: client?.title ?? "Unknown",
        posts: bucket.posts,
        pace: target === 0 ? "—" : percent(bucket.posts, target),
        impressions: compact(bucket.totals.impressions),
        rate: percent(bucket.totals.engagements, bucket.totals.impressions),
      }
    })
    .sort((a, b) => b.posts - a.posts)

  const perPost = new Map<string, Totals>()
  for (const row of results) {
    if (!row.post_id) continue
    const bucket = perPost.get(row.post_id) ?? zero()
    add(bucket, row)
    perPost.set(row.post_id, bucket)
  }

  const postsById = byId(posts)
  const topRows = [...perPost.entries()]
    .sort((a, b) => b[1].engagements - a[1].engagements || b[1].impressions - a[1].impressions)
    .slice(0, 10)
    .map(([postId, bucket]) => {
      const post = postsById.get(postId)
      const clientId = post ? refId(post.data.client) : null
      return {
        post: post?.title ?? "Deleted post",
        client: (clientId && clientsById.get(clientId)?.title) || "—",
        impressions: compact(bucket.impressions),
        engagements: compact(bucket.engagements),
        rate: percent(bucket.engagements, bucket.impressions),
      }
    })

  const pipeline = STAGES.map(stage => ({
    stage: STAGE_LABELS[stage.value] ?? stage.value,
    posts: dated.filter(row => row.stage === stage.value).length,
  })).filter(row => row.posts > 0)

  type Table = {
    label: string
    columns: { key: string; label: string }[]
    rows: Record<string, string | number>[]
  }

  const tables: Table[] = [
    {
      label: "By network",
      columns: [
        { key: "network", label: "Network" },
        { key: "posts", label: "Posts" },
        { key: "impressions", label: "Impressions" },
        { key: "engagements", label: "Engagements" },
        { key: "rate", label: "Rate" },
      ],
      rows: networkRows,
    },
    {
      label: "By client",
      columns: [
        { key: "client", label: "Client" },
        { key: "posts", label: "Posted" },
        { key: "pace", label: "On pace" },
        { key: "impressions", label: "Impressions" },
        { key: "rate", label: "Rate" },
      ],
      rows: clientRows,
    },
    {
      label: "Pipeline",
      columns: [
        { key: "stage", label: "Stage" },
        { key: "posts", label: "Posts" },
      ],
      rows: pipeline,
    },
  ]

  // Only shown once there is something in it — an empty "top posts" table on a
  // fresh install reads as a broken panel rather than an honest zero.
  if (topRows.length > 0) {
    tables.splice(2, 0, {
      label: "Best performing",
      columns: [
        { key: "post", label: "Post" },
        { key: "client", label: "Client" },
        { key: "impressions", label: "Impressions" },
        { key: "engagements", label: "Engagements" },
        { key: "rate", label: "Rate" },
      ],
      rows: topRows,
    })
  }

  return { tiles, series, tables }
}
