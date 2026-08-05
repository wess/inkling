import type { Connection } from "atlas/db"
import type { PluginStats } from "../../src/plugins/define.ts"
import { loadType, refId, text } from "./entries.ts"
import { OPEN_STAGES } from "./model.ts"
import { buildCalendar } from "./queue.ts"

// The calendar, rendered through the `stats` panel the admin already knows how
// to draw: three tiles for the shape of the week, then one table per day.
//
// A plugin cannot ship React into a bundle that was built before it existed, so
// "a calendar" here means choosing the arrangement of primitives that reads
// most like one. A day per table, in order, with an empty day left in — the
// gaps are the most useful thing on it.

export const week = async (
  db: Connection,
  options: { timezone: string; days: number; clientId?: string },
): Promise<PluginStats> => {
  const now = Date.now()

  const [days, posts] = await Promise.all([
    buildCalendar(db, { timezone: options.timezone, from: now, days: options.days, clientId: options.clientId }),
    loadType(db, "socialpost"),
  ])

  const scheduled = days.reduce((total, day) => total + day.posts.length, 0)
  const empty = days.filter(day => day.posts.length === 0).length

  const open = posts
    .filter(post => OPEN_STAGES.includes(text(post.data.stage) || "draft"))
    .filter(post => (options.clientId ? refId(post.data.client) === options.clientId : true))

  const undated = open.filter(post => text(post.data.scheduledFor) === "")
  const overdue = open.filter(post => {
    const at = new Date(text(post.data.scheduledFor)).getTime()
    return Number.isFinite(at) && at < now
  })

  return {
    tiles: [
      { label: "Going out", value: String(scheduled), hint: `over ${options.days} days` },
      {
        label: "Empty days",
        value: String(empty),
        hint: empty === 0 ? "every day covered" : "nothing scheduled",
      },
      { label: "Undated", value: String(undated.length), hint: "written, no date" },
      {
        label: "Overdue",
        value: String(overdue.length),
        hint: overdue.length === 0 ? "nothing slipped" : "past their date, not posted",
      },
    ],
    series: {
      label: "Posts per day",
      points: days.map(day => ({ label: day.label.replace(/^(\w{3})\w*/, "$1"), value: day.posts.length })),
    },
    tables: days.map(day => ({
      label: day.label,
      columns: [
        { key: "time", label: "Time" },
        { key: "client", label: "Client" },
        { key: "title", label: "Post" },
        { key: "networks", label: "Networks" },
        { key: "stage", label: "Stage" },
      ],
      // A day with nothing on it still gets a table, with one row saying so —
      // an omitted day reads as "no data" when what it means is "free".
      rows:
        day.posts.length > 0
          ? day.posts.map(post => ({
              time: post.time,
              client: post.client,
              title: post.title,
              networks: post.networks,
              stage: post.stage,
            }))
          : [{ time: "—", client: "—", title: "Nothing scheduled", networks: "—", stage: "—" }],
    })),
  }
}
