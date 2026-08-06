import { from } from "atlas/db"
import { badRequest, del, get, json, notFound, parseJson, pipeline, post, redirect } from "atlas/server"
import { auth, requireAuth, requireCan } from "../../src/auth/guard.ts"
import { can } from "../../src/auth/roles.ts"
import { corsAll } from "../../src/http/index.ts"
import { decodeObject, encode } from "../../src/json/index.ts"
import { requireApiKey } from "../../src/keys/index.ts"
import { consentUrl, exchange as exchangeCode, readState as readOAuthState } from "../../src/oauth/index.ts"
import { definePlugin } from "../../src/plugins/define.ts"
import { users } from "../../src/schema/index.ts"
import { now } from "../../src/time/index.ts"
import {
  byId as accountById,
  list as listAccounts,
  present as presentAccount,
  remove as removeAccount,
  save as saveAccount,
} from "./accounts.ts"
import { byId, loadType, preview, refTitle, text } from "./entries.ts"
import { contentTypes, OPEN_STAGES, taxonomies } from "./model.ts"
import { labelNetworks, NETWORKS, networkLabel } from "./networks.ts"
import {
  accountFrom,
  CONNECTABLE,
  NETWORK_OAUTH,
  ready as networkReady,
  clientFor as socialClientFor,
  redirectUri as socialRedirectUri,
} from "./oauth.ts"
import { buildCalendar, buildQueue } from "./queue.ts"
import { summarize } from "./report.ts"
import { list as listResults, prune, read as readResult, record as recordResult } from "./results.ts"
import { week } from "./week.ts"

// Social media management: the clients, the channels, the calendar, and the
// argument about whether last month went well.
//
// Everything an editor touches is an ordinary content type (see ./model.ts), so
// the composer, the revision history, the search, and the trash are the ones
// Inkling already has. What this plugin adds is the four readings of that
// content nobody wants to assemble by hand — a queue, a week, a report, and a
// results table — plus the small amount of tidying a post needs on its way in.
//
// Connections are half of publishing and are built: an operator authorizes an
// account per network (./oauth.ts), the tokens are sealed into social_accounts
// (./accounts.ts), and `accessToken` renews one or marks it for reconnection.
// What is deliberately *not* here is the other half — the call that pushes a
// post to a network. Each one wants a different payload, a different media
// upload dance, and a different set of failures, and a plugin that quietly
// stopped posting would be worse than no plugin. So the workflow stays what it
// was: stage a post "Posted" when it goes out and paste the link. The
// connection is what a per-network publisher will be built on, one at a time.

const KNOWN_NETWORKS = new Set(NETWORKS.map(network => network.value))

// What rides through the network and back in the sealed `state`. `clientId` is
// carried even though it is always "" today, because the alternative is a
// second state shape the moment per-client connections arrive.
type SocialPending = { readonly network: string; readonly clientId: string; readonly userId: string }

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
      id: "accounts",
      label: "Accounts",
      icon: "link",
      kind: "connections",
      endpoint: "/ext/social/accounts",
      description:
        "Authorize the accounts this install may act as. Tokens are sealed and renewed automatically. Posting is still done by hand — stage a post Posted and paste the link.",
    },
    {
      id: "socialsettings",
      label: "Social settings",
      icon: "sliders",
      kind: "settings",
      // Says where the accounts are, because this is the screen someone opens
      // looking for them — "settings" is where you go to connect a thing.
      description: "How the calendar and queue behave. To connect the accounts themselves, see Accounts.",
    },
  ],

  routes: ctx => {
    // Reading a client's plan is editorial work, so an author may do it.
    // Recording results is not, and neither is reading the report.
    const planning = pipeline(requireAuth(ctx.db), requireCan(can.writeContent, "read the social queue"))
    const reporting = pipeline(requireAuth(ctx.db), requireCan(can.publishContent, "read social performance"))
    // Connecting an account hands this install the right to post as someone's
    // brand. That is an administrative act, not an editorial one, so it sits
    // with plugin management rather than with publishing.
    const connecting = pipeline(requireAuth(ctx.db), requireCan(can.managePlugins, "connect social accounts"))

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

      // ------------------------------------------------------ connections

      // What the connections panel draws: every network that could be
      // connected, whether an app is registered for it, and what we hold.
      get(
        "/accounts",
        connecting(async c => {
          const held = new Map((await listAccounts(ctx.db)).map(row => [`${row.network}:${row.client_id}`, row]))

          return json(c, 200, {
            data: {
              redirectUri: socialRedirectUri(),
              connections: CONNECTABLE.map(network => {
                const row = held.get(`${network.value}:`)
                return {
                  id: network.value,
                  label: network.label,
                  configured: networkReady(network.value),
                  scopes: NETWORK_OAUTH[network.value]?.scopes ?? [],
                  connection: row ? presentAccount(row) : null,
                }
              }),
            },
          })
        }),
      ),

      // Returns the consent URL rather than redirecting: the caller is the
      // admin SPA on a fetch, and a 302 to a third party would be followed by
      // the fetch rather than by the browser's address bar.
      post(
        "/accounts/:network/start",
        connecting(async c => {
          const network = String(c.params.network ?? "")
          const client = socialClientFor(network)
          if (!client) {
            throw badRequest(`No developer app is registered for ${networkLabel(network)}`, { code: "NO_OAUTH_CLIENT" })
          }

          const identity = auth(c)
          const { url, expiresAt } = await consentUrl<SocialPending>(
            client,
            socialRedirectUri(),
            { network, clientId: "", userId: identity.id },
            NETWORK_OAUTH[network]?.extra ?? {},
          )
          return json(c, 200, { data: { url, expiresAt } })
        }),
      ),

      del(
        "/accounts/:id",
        connecting(async c => {
          const row = await accountById(ctx.db, String(c.params.id ?? ""))
          if (!row) throw notFound("That connection no longer exists")
          await removeAccount(ctx.db, row.id)
          return json(c, 200, { data: { id: row.id } })
        }),
      ),

      // Public, because the browser arrives here by top-level navigation from
      // the network and carries no session cookie for a fetch to attach. What
      // stands in for one is the sealed `state`: it names the admin who started
      // the flow, expires in ten minutes, and cannot be minted without SECRET.
      // The capability is re-read on the way through, so an account demoted
      // mid-flow does not get to finish it.
      get("/oauth/callback", async c => {
        const back = (outcome: string, detail?: string) =>
          redirect(
            c,
            `${ctx.adminBase}/plugins/social/accounts?connected=${encodeURIComponent(outcome)}` +
              (detail ? `&reason=${encodeURIComponent(detail.slice(0, 300))}` : ""),
          )

        const denied = typeof c.query.error === "string" ? c.query.error : ""
        if (denied) return back("error", String(c.query.error_description ?? denied))

        const pending = await readOAuthState<SocialPending>(typeof c.query.state === "string" ? c.query.state : "")
        if (!pending || typeof pending.network !== "string") {
          return back("error", "That connection link expired or was not issued by this site")
        }

        const code = typeof c.query.code === "string" ? c.query.code : ""
        if (!code) return back("error", `${networkLabel(pending.network)} returned no authorization code`)

        const client = socialClientFor(pending.network)
        if (!client) return back("error", "That network's developer app is no longer configured")

        const actor = await ctx.db.one<{ id: string; role: string; deleted_at: string | null }>(
          from(users).where(q => q("id").equals(pending.userId)),
        )
        if (!actor || actor.deleted_at || !can.managePlugins(actor.role)) {
          return back("error", "That account may no longer connect social accounts")
        }

        try {
          const tokens = await exchangeCode(client, socialRedirectUri(), code, pending.verifier)
          const account = accountFrom(tokens.payload)
          await saveAccount(ctx.db, {
            network: pending.network,
            clientId: pending.clientId ?? "",
            account,
            accountId: null,
            userId: actor.id,
            tokens,
          })
          return back("ok", account ?? networkLabel(pending.network))
        } catch (error) {
          return back("error", error instanceof Error ? error.message : "The network refused the connection")
        }
      }),
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
  },

  install: async ctx => {
    ctx.log("clients, channels, campaigns, and posts registered; results table ready")
  },
})
