import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import { rows as query } from "../../src/db/dialect.ts"
import { id as newId } from "../../src/ids/index.ts"
import { now } from "../../src/time/index.ts"

// Writing and reading `social_results`. Numbers arrive one of two ways: typed
// in after a weekly check, or posted by whatever script someone eventually
// points at a network's API. Both go through `read` first, so the table cannot
// hold a value the report would then have to defend itself against.

export type ResultRow = {
  id: string
  client_id: string | null
  post_id: string | null
  channel_id: string | null
  network: string
  day: string
  impressions: number
  engagements: number
  clicks: number
  follows: number
  spend_cents: number
  source: string
  created_at: string
}

export type ResultInput = {
  readonly clientId: string | null
  readonly postId: string | null
  readonly channelId: string | null
  readonly network: string
  readonly day: string
  readonly impressions: number
  readonly engagements: number
  readonly clicks: number
  readonly follows: number
  readonly spendCents: number
  readonly source: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

const idOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 64) : null

// Counts are whole and non-negative. A float or a negative is a broken
// integration rather than a real measurement, and clamping keeps one bad push
// from making a quarter's totals meaningless.
const count = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.min(Math.round(parsed), 2_000_000_000)
}

export const read = (payload: Record<string, unknown>): ResultInput | null => {
  const network = typeof payload.network === "string" ? payload.network.trim().toLowerCase().slice(0, 32) : ""
  if (!network) return null

  const day = typeof payload.day === "string" && DAY.test(payload.day) ? payload.day : now().slice(0, 10)

  const spend = typeof payload.spendCents === "number" ? payload.spendCents : Number(payload.spend ?? 0) * 100

  return {
    clientId: idOf(payload.clientId),
    postId: idOf(payload.postId),
    channelId: idOf(payload.channelId),
    network,
    day,
    impressions: count(payload.impressions),
    engagements: count(payload.engagements),
    clicks: count(payload.clicks),
    follows: count(payload.follows),
    spendCents: count(spend),
    source: typeof payload.source === "string" ? payload.source.trim().slice(0, 32) || "manual" : "manual",
  }
}

// One row per (day, network, post, channel). A weekly check re-reports the same
// day's numbers as they mature, and appending would count the same impressions
// three times — so the existing row is replaced rather than added to.
export const record = async (db: Connection, input: ResultInput): Promise<string> => {
  // The pair that identifies a slot is nullable, and `= NULL` matches nothing
  // on either dialect. Narrowing in SQL to the day and network — which are
  // never null — and comparing the rest in memory is the spelling that does not
  // need a three-valued predicate.
  const sameDay = await query<{ id: string; post_id: string | null; channel_id: string | null }>(
    db,
    from("social_results", "r")
      .select("r.id", "r.post_id", "r.channel_id")
      .where(q => q("r.day").equals(input.day))
      .where(q => q("r.network").equals(input.network))
      .limit(500),
  )

  const existing = sameDay.find(row => row.post_id === input.postId && row.channel_id === input.channelId)

  const values = {
    client_id: input.clientId,
    post_id: input.postId,
    channel_id: input.channelId,
    network: input.network,
    day: input.day,
    impressions: input.impressions,
    engagements: input.engagements,
    clicks: input.clicks,
    follows: input.follows,
    spend_cents: input.spendCents,
    source: input.source,
  }

  if (existing) {
    await db.execute(
      from("social_results")
        .where(q => q("id").equals(existing.id))
        .update(values),
    )
    return existing.id
  }

  const id = newId()
  await db.execute(from("social_results").insert({ id, ...values, created_at: now() }))
  return id
}

// Retention runs off a write rather than a timer, for the reason the analytics
// plugin gives: a plugin that installs its own setInterval keeps running after
// it has been disabled. Once a day is often enough for a table that only grows
// when somebody reports numbers.
let sweptOn = ""

export const prune = async (db: Connection, retentionDays: number): Promise<void> => {
  const today = now().slice(0, 10)
  if (retentionDays <= 0 || sweptOn === today) return
  sweptOn = today

  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString().slice(0, 10)
  await db
    .execute(
      from("social_results")
        .where(q => q("day").lessThan(cutoff))
        .del(),
    )
    .catch(() => {})
}

export const list = async (
  db: Connection,
  options: { since: string; clientId?: string; postId?: string; limit: number },
): Promise<ResultRow[]> => {
  let builder = from("social_results", "r")
    .select(
      "r.id",
      "r.client_id",
      "r.post_id",
      "r.channel_id",
      "r.network",
      "r.day",
      "r.impressions",
      "r.engagements",
      "r.clicks",
      "r.follows",
      "r.spend_cents",
      "r.source",
      "r.created_at",
    )
    .where(q => q("r.day").greaterThanOrEqual(options.since))

  if (options.clientId) builder = builder.where(q => q("r.client_id").equals(options.clientId as string))
  if (options.postId) builder = builder.where(q => q("r.post_id").equals(options.postId as string))

  return query<ResultRow>(db, builder.orderBy("r.day", "DESC").limit(options.limit))
}
