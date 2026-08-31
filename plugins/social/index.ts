import { from } from "atlas/db"
import { get, json, parseJson, pipeline, post } from "atlas/server"
import { requireAuth, requireCan } from "../../src/auth/guard.ts"
import { can } from "../../src/auth/roles.ts"
import { corsAll } from "../../src/http/index.ts"
import { decodeObject, encode } from "../../src/json/index.ts"
import { requireApiKey } from "../../src/keys/index.ts"
import { definePlugin } from "../../src/plugins/define.ts"
import { entries } from "../../src/schema/index.ts"
import { now } from "../../src/time/index.ts"
import { byId, loadType, preview, refTitle, text } from "./entries.ts"
import { contentTypes, OPEN_STAGES, taxonomies } from "./model.ts"
import { labelNetworks, NETWORKS } from "./networks.ts"
import { buildCalendar, buildQueue } from "./queue.ts"
import { summarize } from "./report.ts"
import { list as listResults, prune, read as readResult, record as recordResult } from "./results.ts"
import { week } from "./week.ts"

// Agency-side social planning: the clients, the channels, the calendar, and the
// argument about whether last month went well.
//
// This is the layer *above* posting, and posting is no longer here. Connecting
// accounts and sending to a network moved into core (`src/social`, the Social
// section in the admin) the moment those needed a composer and a background
// sweep — a plugin can ship neither, because the admin bundle is built before
// any plugin exists and a plugin's setInterval outlives its own disable switch.
//
// What is left is the part that was always the plugin's: a plan sold to a
// client, and the reading of it nobody wants to assemble by hand. Everything an
// editor touches is an ordinary content type (see ./model.ts), so the editor,
// the revision history, the search, and the trash are the ones Inkling already
// has, and this file adds a queue, a week, a report, and a results table on top
// of them.
//
// The two overlap without colliding. A `socialpost` here is a commitment to a
// client — approved on a date, counted against a contract — and its `stage`
// records what happened to it. A post in the Social section is a thing that
// gets sent. An agency uses both; a solo operator only ever needs the second.

const KNOWN_NETWORKS = new Set(NETWORKS.map(network => network.value))

const setting = async (
  ctx: { getSetting: <T>(key: string, fallback: T) => Promise<T> },
  key: string,
  fallback: number,
): Promise<number> => Number(await ctx.getSetting(key, fallback)) || fallback

const range = (value: unknown, fallback: number, ceiling: number): number =>
  Math.min(Math.max(Number(value) || fallback, 1), ceiling)

// Space-separated words in, hashtags out. Editors type all four spellings of
// this field and every one of them is meant the same way.
export const tidyHashtags = (value: string): string => {
  const seen = new Set<string>()
  return value
    .split(/[\s,]+/)
    .map(word => word.replace(/^#+/, "").trim())
    .filter(word => word !== "")
    .filter(word => {
      const key = word.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(word => `#${word}`)
    .join(" ")
}

export default definePlugin({
  name: "social",
  version: "1.0.0",
  label: "Social",
  description: "Clients, channels, a content calendar, and what the posts actually did.",
  author: "Inkling",

  taxonomies,
  contentTypes,

  settings: [
    {
      key: "timezone",
      label: "Posting timezone",
      type: "text",
      default: "America/New_York",
      help: "IANA name. Times are stored in UTC and read back in this zone.",
    },
    {
      key: "queueDays",
      label: "Queue horizon (days)",
      type: "number",
      default: 21,
      help: "How far ahead the queue looks. Undated posts always show, however far out this is.",
    },
    {
      key: "leadTimeDays",
      label: "Draft lead time (days)",
      type: "number",
      default: 3,
      help: "A post still being drafted this close to its date is flagged.",
    },
    {
      key: "defaultNetworks",
      label: "Default networks",
      type: "text",
      default: "instagram,facebook",
      help: "Comma-separated. Applied to a new post that names none.",
    },
    {
      key: "resultsRetentionDays",
      label: "Keep results for (days)",
      type: "number",
      default: 730,
      help: "0 keeps everything. Older rows are dropped when new ones are recorded.",
    },
  ],

  panels: [
    {
      id: "week",
      label: "Calendar",
      icon: "calendar",
      kind: "stats",
      endpoint: "/ext/social/calendar",
      ranges: [7, 14, 30],
      description: "What goes out, day by day.",
    },
    {
      id: "queue",
      label: "Queue",
      icon: "list-checks",
      kind: "table",
      endpoint: "/ext/social/queue",
      columns: [
        { key: "when", label: "Goes out" },
        { key: "client", label: "Client" },
        { key: "title", label: "Post" },
        { key: "networks", label: "Networks" },
        { key: "stage", label: "Stage" },
        { key: "flag", label: "Needs" },
      ],
      description: "Everything not yet posted, soonest first.",
    },
    { id: "posts", label: "Posts", icon: "send", kind: "collection", contentType: "socialpost" },
    { id: "clients", label: "Clients", icon: "briefcase", kind: "collection", contentType: "socialclient" },
    { id: "channels", label: "Channels", icon: "at-sign", kind: "collection", contentType: "socialchannel" },
    { id: "campaigns", label: "Campaigns", icon: "target", kind: "collection", contentType: "socialcampaign" },
    {
      id: "performance",
      label: "Performance",
      icon: "trending-up",
      kind: "stats",
      endpoint: "/ext/social/performance",
      ranges: [7, 30, 90],
      description: "Cadence against what was sold, and what the posts did.",
    },
    {
      id: "socialsettings",
      label: "Social settings",
      icon: "sliders",
      kind: "settings",
      // Says where the accounts are, because this is the screen someone opens
      // looking for them — "settings" is where you go to connect a thing.
      description: "How the client calendar and queue behave. To connect accounts and send posts, see Social.",
    },
  ],

  routes: ctx => {
    // Reading a client's plan is editorial work, so an author may do it.
    // Recording results is not, and neither is reading the report.
    const planning = pipeline(requireAuth(ctx.db), requireCan(can.writeContent, "read the social queue"))
    const reporting = pipeline(requireAuth(ctx.db), requireCan(can.publishContent, "read social performance"))

    const timezone = async (): Promise<string> => String(await ctx.getSetting("timezone", "America/New_York"))

    return [
      get(
        "/queue",
        planning(async c => {
          const rows = await buildQueue(ctx.db, {
            timezone: await timezone(),
            days: c.query.days ? range(c.query.days, 21, 365) : await setting(ctx, "queueDays", 21),
            leadTimeDays: await setting(ctx, "leadTimeDays", 3),
            clientId: typeof c.query.client === "string" ? c.query.client : undefined,
            stages: OPEN_STAGES,
          })
          return json(c, 200, { data: rows })
        }),
      ),

      get(
        "/calendar",
        planning(async c =>
          json(c, 200, {
            data: await week(ctx.db, {
              timezone: await timezone(),
              days: range(c.query.days, 7, 90),
              clientId: typeof c.query.client === "string" ? c.query.client : undefined,
            }),
          }),
        ),
      ),

      // The same days as the panel, unrendered — for anything that wants to
      // draw its own grid, including a client-facing page on the site.
      get(
        "/schedule",
        planning(async c =>
          json(c, 200, {
            data: await buildCalendar(ctx.db, {
              timezone: await timezone(),
              from: Date.now(),
              days: range(c.query.days, 14, 90),
              clientId: typeof c.query.client === "string" ? c.query.client : undefined,
            }),
          }),
        ),
      ),

      get(
        "/performance",
        reporting(async c => json(c, 200, { data: await summarize(ctx.db, range(c.query.days, 30, 365)) })),
      ),

      get(
        "/results",
        reporting(async c =>
          json(c, 200, {
            data: await listResults(ctx.db, {
              since: new Date(Date.now() - range(c.query.days, 90, 1_095) * 86_400_000).toISOString().slice(0, 10),
              clientId: typeof c.query.client === "string" ? c.query.client : undefined,
              postId: typeof c.query.post === "string" ? c.query.post : undefined,
              limit: range(c.query.limit, 500, 5_000),
            }),
          }),
        ),
      ),

      // Numbers come from outside — a spreadsheet import, a script against a
      // network's API, or a person with a browser tab open. Key-authenticated
      // like every other write from beyond the admin.
      post(
        "/results",
        pipeline(
          corsAll,
          requireApiKey(ctx.db),
          parseJson,
        )(async c => {
          const payload = (c.body ?? {}) as Record<string, unknown>
          const batch = Array.isArray(payload.results) ? payload.results : [payload]

          const accepted: string[] = []
          for (const item of batch.slice(0, 500)) {
            const input = readResult((item ?? {}) as Record<string, unknown>)
            if (input) accepted.push(await recordResult(ctx.db, input))
          }

          await prune(ctx.db, await setting(ctx, "resultsRetentionDays", 730))

          return json(c, accepted.length > 0 ? 201 : 400, {
            recorded: accepted.length,
            ids: accepted,
          })
        }),
      ),

      // Published, posted work with a link on it — the "recent work" strip a
      // marketing site wants, without handing it the whole plan. Only entries
      // an editor has published are visible, so a draft plan is never public.
      get(
        "/highlights",
        pipeline(
          corsAll,
          requireApiKey(ctx.db),
        )(async c => {
          const limit = range(c.query.limit, 12, 48)
          const [posts, clients] = await Promise.all([loadType(ctx.db, "socialpost"), loadType(ctx.db, "socialclient")])
          const lookup = byId(clients)

          const data = posts
            .filter(item => item.status === "published")
            .filter(item => text(item.data.stage) === "posted")
            .filter(item => text(item.data.postedUrl) !== "")
            .sort((a, b) => text(b.data.scheduledFor).localeCompare(text(a.data.scheduledFor)))
            .slice(0, limit)
            .map(item => ({
              id: item.id,
              title: item.title,
              client: refTitle(item.data.client, lookup, ""),
              caption: preview(item.data.caption, 240),
              networks: labelNetworks(item.data.networks),
              url: text(item.data.postedUrl),
              postedAt: text(item.data.scheduledFor) || null,
            }))

          return json(c, 200, { data })
        }),
      ),
    ]
  },

  register: ctx => {
    // The only write the plugin makes to content, and a filter rather than a
    // hook on purpose: if any of this throws, the save carries on with the
    // editor's own values instead of failing.
    //
    // It runs *after* validation, so everything it writes has to already be a
    // legal value for its field — which is why the default networks are checked
    // against the real list rather than trusted from a settings box.
    ctx.filter("entry.beforeSave", async ({ entry, type, identity }) => {
      if (type.name !== "socialpost") return { entry, type, identity }

      const data = decodeObject(entry.data)
      const stage = text(data.stage) || "draft"

      const chosen = Array.isArray(data.networks) ? data.networks.map(String) : []
      const networks =
        chosen.length > 0
          ? chosen
          : String(await ctx.getSetting("defaultNetworks", "instagram,facebook"))
              .split(",")
              .map(name => name.trim().toLowerCase())
              .filter(name => KNOWN_NETWORKS.has(name))

      // Approval is a fact with a time and a name on it. Stamped here so it is
      // recorded by whoever moved the stage, rather than by whoever remembered
      // to fill the field in — and cleared when a post goes back for changes,
      // because an old approval on a rewritten post is worse than none.
      const approved = stage === "approved" || stage === "scheduled" || stage === "posted"

      const next = {
        ...data,
        hashtags: tidyHashtags(text(data.hashtags)),
        networks,
        approvedOn: approved ? text(data.approvedOn) || now() : null,
        approvedBy: approved ? text(data.approvedBy) || identity?.name || "" : "",
      }

      return { entry: { ...entry, data: encode(next) }, type, identity }
    })

    ctx.on("social.posted", async payload => {
      const planned = (await loadType(ctx.db, "socialpost")).find(item => text(item.data.publishPostId) === payload.id)
      if (!planned) return

      const errors = payload.targets.filter(target => target.error).map(target => `${target.network}: ${target.error}`)
      const data = {
        ...planned.data,
        publishStatus: payload.status,
        publishError: errors.join("\n"),
        postedAt: payload.status === "posted" ? now() : text(planned.data.postedAt),
        postedUrl: text(planned.data.postedUrl),
        stage: payload.status === "posted" ? "posted" : text(planned.data.stage),
      }

      await ctx.db.execute(
        from(entries)
          .update({ data: encode(data), updated_at: now() })
          .where(q => q("id").equals(planned.id)),
      )
    })
  },

  install: async ctx => {
    ctx.log("clients, channels, campaigns, and posts registered; results table ready")
  },
})
