import type { Connection } from "atlas/db"
import { byId, loadType, preview, refTitle, text } from "./entries.ts"
import { STAGE_LABELS } from "./model.ts"
import { labelNetworks, overLimit } from "./networks.ts"

// The queue: everything not yet posted, in the order it goes out.
//
// This is the one screen the work actually happens on, so it is a *reading* of
// the posts rather than a second store — nothing here is written back. A row
// is one post with the three things you check before you approve it: when it
// goes, where it goes, and what is still missing.

export type QueueRow = {
  readonly id: string
  readonly when: string
  readonly client: string
  readonly title: string
  readonly networks: string
  readonly stage: string
  readonly flag: string
}

const DAY = 86_400_000

const formatter = (timezone: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    })
  } catch {
    // An invalid IANA name is a typo in a settings field, not a reason for the
    // queue to 500. UTC is the honest fallback because it is what is stored.
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    })
  }
}

// "in 3 days" reads faster than a date when the date is close, and a date reads
// better than "in 61 days" when it is not. The threshold is where those cross.
const relative = (ms: number): string => {
  if (ms < 0) {
    const days = Math.floor(-ms / DAY)
    if (days === 0) return "overdue"
    return days === 1 ? "overdue by a day" : `overdue by ${days} days`
  }
  const hours = Math.round(ms / 3_600_000)
  if (hours < 1) return "within the hour"
  if (hours < 24) return `in ${hours}h`
  const days = Math.round(ms / DAY)
  return days <= 14 ? `in ${days}d` : ""
}

// What to chase, in the order you would chase it. Only the first is shown —
// a row with four warnings on it is a row nobody reads.
const flagFor = (post: {
  stage: string
  scheduledFor: string | null
  daysOut: number | null
  leadTimeDays: number
  caption: string
  networks: unknown
  mediaCount: number
  format: string
  assetBrief: string
}): string => {
  if (post.stage === "review") return "Waiting on approval"
  if (post.scheduledFor === null && post.stage !== "idea") return "No date set"

  // Still being written with less runway than the lead time allows. The one
  // warning that is about the calendar rather than the post.
  if (post.daysOut !== null && post.daysOut <= post.leadTimeDays && (post.stage === "idea" || post.stage === "draft")) {
    return post.daysOut <= 0 ? "Due now, still drafting" : `Due in ${Math.ceil(post.daysOut)}d, still drafting`
  }

  const long = overLimit(post.networks, post.caption)
  if (long.length > 0) return `Too long for ${long.join(", ")}`

  if (post.caption.trim() === "" && post.stage !== "idea") return "No caption"
  if (!Array.isArray(post.networks) || post.networks.length === 0) return "No network chosen"
  if (post.mediaCount === 0 && post.format !== "text") {
    return post.assetBrief.trim() === "" ? "No assets" : "Assets outstanding"
  }
  if (post.stage === "approved" && post.scheduledFor !== null) return "Ready to schedule"
  return ""
}

export type QueueOptions = {
  readonly timezone: string
  // Posts further out than this are plans, not a queue.
  readonly days: number
  readonly leadTimeDays: number
  readonly clientId?: string
  readonly stages: readonly string[]
}

export const buildQueue = async (db: Connection, options: QueueOptions): Promise<QueueRow[]> => {
  const [posts, clients] = await Promise.all([loadType(db, "socialpost"), loadType(db, "socialclient")])
  const lookup = byId(clients)
  const format = formatter(options.timezone)
  const now = Date.now()
  const horizon = now + options.days * DAY

  return (
    posts
      .map(post => {
        const scheduledFor = text(post.data.scheduledFor) || null
        const at = scheduledFor === null ? null : new Date(scheduledFor).getTime()
        return {
          post,
          scheduledFor,
          at: at !== null && Number.isFinite(at) ? at : null,
          stage: text(post.data.stage) || "draft",
          clientId: post.data.client,
        }
      })
      .filter(row => options.stages.includes(row.stage))
      .filter(row => (options.clientId ? row.clientId === options.clientId : true))
      // An undated post stays in the queue however far out the window is: it is
      // the thing most likely to be forgotten, so it cannot be filtered away by a
      // date it does not have.
      .filter(row => row.at === null || row.at <= horizon)
      .sort((a, b) => {
        if (a.at === null) return b.at === null ? 0 : 1
        if (b.at === null) return -1
        return a.at - b.at
      })
      .map(row => {
        const data = row.post.data
        const media = Array.isArray(data.media) ? data.media.length : 0
        const away = row.at === null ? "" : relative(row.at - now)

        return {
          id: row.post.id,
          when: row.at === null ? "Unscheduled" : `${format.format(new Date(row.at))}${away ? ` · ${away}` : ""}`,
          client: refTitle(data.client, lookup),
          title: row.post.title,
          networks: labelNetworks(data.networks),
          stage: STAGE_LABELS[row.stage] ?? row.stage,
          flag: flagFor({
            stage: row.stage,
            scheduledFor: row.scheduledFor,
            daysOut: row.at === null ? null : (row.at - now) / DAY,
            leadTimeDays: options.leadTimeDays,
            caption: text(data.caption),
            networks: data.networks,
            mediaCount: media,
            format: text(data.format) || "single",
            assetBrief: text(data.assetBrief),
          }),
        }
      })
  )
}

// The same posts grouped by day, which is what a calendar is once the grid is
// somebody else's problem. Kept separate from buildQueue because a week view
// wants every stage including the ones already posted — the point of looking at
// a week is seeing how full it is.
export type CalendarDay = {
  readonly day: string
  readonly label: string
  readonly posts: readonly {
    id: string
    time: string
    client: string
    title: string
    networks: string
    stage: string
  }[]
}

const dayKey = (at: number, timezone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(at))
  } catch {
    return new Date(at).toISOString().slice(0, 10)
  }
}

export const buildCalendar = async (
  db: Connection,
  options: { timezone: string; from: number; days: number; clientId?: string },
): Promise<CalendarDay[]> => {
  const [posts, clients] = await Promise.all([loadType(db, "socialpost"), loadType(db, "socialclient")])
  const lookup = byId(clients)

  const time = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: options.timezone })
    } catch {
      return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    }
  })()

  const dayLabel = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        timeZone: options.timezone,
      })
    } catch {
      return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })
    }
  })()

  // Sorted on the timestamp rather than the rendered time, because "9:00 AM"
  // sorts after "10:00 AM" as a string. `at` is dropped on the way out.
  type Slot = CalendarDay["posts"][number] & { at: number }
  const buckets = new Map<string, Slot[]>()
  for (let index = 0; index < options.days; index++) {
    buckets.set(dayKey(options.from + index * DAY, options.timezone), [])
  }

  for (const post of posts) {
    const scheduledFor = text(post.data.scheduledFor)
    if (!scheduledFor) continue
    const at = new Date(scheduledFor).getTime()
    if (!Number.isFinite(at)) continue
    if (options.clientId && post.data.client !== options.clientId) continue

    const bucket = buckets.get(dayKey(at, options.timezone))
    if (!bucket) continue

    bucket.push({
      id: post.id,
      at,
      time: time.format(new Date(at)),
      client: refTitle(post.data.client, lookup),
      title: post.title || preview(post.data.caption, 60),
      networks: labelNetworks(post.data.networks),
      stage: STAGE_LABELS[text(post.data.stage)] ?? text(post.data.stage),
    })
  }

  return [...buckets.entries()].map(([day, entries]) => ({
    day,
    label: dayLabel.format(new Date(`${day}T12:00:00Z`)),
    posts: entries.sort((a, b) => a.at - b.at).map(({ at: _at, ...slot }) => slot),
  }))
}
