import { badRequest, get, json, parseJson, pipeline, post, tooManyRequests } from "atlas/server"
import { requireAuth, requireCan } from "../../src/auth/guard.ts"
import { can } from "../../src/auth/roles.ts"
import { corsAll } from "../../src/http/index.ts"
import { requireApiKey } from "../../src/keys/index.ts"
import { definePlugin } from "../../src/plugins/define.ts"
import { clientIp, createRateLimit, userAgent } from "../../src/security/index.ts"
import { now } from "../../src/time/index.ts"
import { dayOf, isBot, prune, readBeacon, record, visitorKey } from "./ingest.ts"
import { summarize } from "./report.ts"

// First-party traffic analytics. Cookieless, no cross-day identifier, and no
// address ever reaches the table — see ./ingest.ts for what a beacon is reduced
// to before it is stored.
//
// The site posts to /ext/analytics/collect with a delivery key, exactly like it
// posts a form submission. Reading the numbers back needs a session.

const setting = async (
  ctx: { getSetting: <T>(key: string, fallback: T) => Promise<T> },
  key: string,
  fallback: number,
): Promise<number> => Number(await ctx.getSetting(key, fallback)) || fallback

const hosts = (raw: string): string[] =>
  raw
    .split(",")
    .map(host =>
      host
        .trim()
        .toLowerCase()
        .replace(/^www\./, ""),
    )
    .filter(Boolean)

export default definePlugin({
  name: "analytics",
  version: "1.0.0",
  label: "Analytics",
  description: "Cookieless pageview and event analytics collected from the public site.",
  author: "Inkling",

  settings: [
    {
      key: "retentionDays",
      label: "Keep events for (days)",
      type: "number",
      default: 90,
      help: "Older rows are deleted on the first beacon of each day. 0 keeps everything.",
    },
    {
      key: "ignorePaths",
      label: "Ignored paths",
      type: "text",
      default: "",
      help: "Comma-separated path prefixes to drop, e.g. /preview,/admin",
    },
    {
      key: "internalHosts",
      label: "Internal hosts",
      type: "text",
      default: "",
      help: "Referrers from these hosts count as navigation within the site, not as a source.",
    },
    {
      key: "perMinutePerIp",
      label: "Beacons per minute per IP",
      type: "number",
      default: 120,
      help: "A page with several events still fits well inside this.",
    },
  ],

  panels: [
    {
      id: "traffic",
      label: "Traffic",
      icon: "activity",
      kind: "stats",
      endpoint: "/ext/analytics/summary",
      ranges: [7, 30, 90],
      description: "Pageviews and events from the public site.",
    },
    { id: "settings", label: "Analytics settings", icon: "sliders", kind: "settings" },
  ],

  routes: ctx => {
    const limiter = createRateLimit(ctx.db)
    const authed = pipeline(requireAuth(ctx.db), requireCan(can.manageSettings, "read analytics"))

    return [
      post(
        "/collect",
        pipeline(
          corsAll,
          requireApiKey(ctx.db),
          parseJson,
        )(async c => {
          const payload = (c.body ?? {}) as Record<string, unknown>

          // The site proxies its visitors' beacons, so the socket peer is the
          // site's own server and every visitor would hash identically. A key
          // holder is a trusted server-side consumer, so it may name the real
          // client. Both values are hash inputs only — neither is stored.
          const request = c.request as Request & { peerIp?: string }
          const ip = typeof payload.ip === "string" ? payload.ip.slice(0, 64) : clientIp(request)
          const agent = typeof payload.ua === "string" ? payload.ua.slice(0, 512) : userAgent(request)

          const perMinute = await setting(ctx, "perMinutePerIp", 120)
          const verdict = await limiter.check(`analytics:${ip}`, perMinute, 60)
          if (!verdict.ok) {
            throw tooManyRequests("Too many beacons. Try again shortly.", {
              code: "RATE_LIMITED",
              headers: { "retry-after": String(verdict.retryAfter) },
            })
          }

          const internal = hosts(String(await ctx.getSetting("internalHosts", "")))
          const beacon = readBeacon(payload, internal)
          if (!beacon) throw badRequest("A `path` is required", { code: "NO_PATH" })

          const ignored = hosts(String(await ctx.getSetting("ignorePaths", "")))
          const skip = isBot(agent) || ignored.some(prefix => beacon.path.startsWith(prefix))

          // A dropped beacon is still a 202. The browser cannot act on the
          // difference, and telling a client which paths are ignored or which
          // user agents are filtered only helps someone trying to evade it.
          if (!skip) {
            const day = dayOf(now())
            await record(ctx.db, beacon, await visitorKey(day, ip, agent))
            await prune(ctx.db, await setting(ctx, "retentionDays", 90), day)
          }

          return json(c, 202, { received: true })
        }),
      ),

      get(
        "/summary",
        authed(async c => {
          const days = Math.min(Math.max(Number(c.query.days) || 30, 1), 365)
          return json(c, 200, { data: await summarize(ctx.db, days) })
        }),
      ),
    ]
  },
})
