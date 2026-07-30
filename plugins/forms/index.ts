import { from } from "@atlas/db"
import { badRequest, del, get, json, parseJson, pipeline, post, tooManyRequests } from "@atlas/server"
import { requireAuth, requireCan } from "../../src/auth/guard.ts"
import { can } from "../../src/auth/roles.ts"
import { corsAll } from "../../src/http/index.ts"
import { id } from "../../src/ids/index.ts"
import { decodeObject, encode } from "../../src/json/index.ts"
import { requireApiKey } from "../../src/keys/index.ts"
import { definePlugin } from "../../src/plugins/define.ts"
import { clientIp, createRateLimit, userAgent } from "../../src/security/index.ts"
import { now } from "../../src/time/index.ts"

// Demonstrates a plugin that owns a table (see ./migrations), exposes both a
// public write route and an authenticated read route, and contributes a table
// panel to the admin.

type SubmissionRow = {
  id: string
  form: string
  data: string
  ip: string | null
  user_agent: string | null
  read_at: string | null
  created_at: string
}

const MAX_FIELDS = 40
const MAX_VALUE_LENGTH = 5_000

export default definePlugin({
  name: "forms",
  version: "1.0.0",
  label: "Forms",
  description: "Collects form submissions from the public site and lists them in the admin.",
  author: "Inkling",

  settings: [
    {
      key: "allowedForms",
      label: "Allowed form names",
      type: "text",
      default: "contact",
      help: "Comma-separated. Submissions to any other name are rejected.",
    },
    { key: "perHourPerIp", label: "Submissions per hour per IP", type: "number", default: 10 },
  ],

  panels: [
    {
      id: "submissions",
      label: "Form submissions",
      icon: "inbox",
      kind: "table",
      endpoint: "/ext/forms/submissions",
      columns: [
        { key: "form", label: "Form" },
        { key: "summary", label: "Submission" },
        { key: "createdAt", label: "Received" },
      ],
    },
  ],

  routes: ctx => {
    const limiter = createRateLimit(ctx.db)
    const authed = pipeline(requireAuth(ctx.db), requireCan(can.manageSettings, "read form submissions"))

    return [
      // Public write. Key-authenticated like the rest of the delivery surface,
      // and rate-limited per IP because it is the one route that writes.
      post(
        "/submit",
        pipeline(
          corsAll,
          requireApiKey(ctx.db),
          parseJson,
        )(async c => {
          const payload = (c.body ?? {}) as Record<string, unknown>
          const form = typeof payload.form === "string" ? payload.form.trim() : ""
          if (!form) throw badRequest("A `form` name is required", { code: "NO_FORM" })

          const allowed = String(await ctx.getSetting("allowedForms", "contact"))
            .split(",")
            .map(name => name.trim())
            .filter(Boolean)
          if (!allowed.includes(form)) {
            throw badRequest(`"${form}" is not an accepted form name`, { code: "UNKNOWN_FORM" })
          }

          const perHour = Number(await ctx.getSetting("perHourPerIp", 10)) || 10
          const ip = clientIp(c.request as Request & { peerIp?: string })
          const verdict = await limiter.check(`forms:${form}:${ip}`, perHour, 3600)
          if (!verdict.ok) {
            throw tooManyRequests("Too many submissions. Try again later.", {
              code: "RATE_LIMITED",
              headers: { "retry-after": String(verdict.retryAfter) },
            })
          }

          // Accept arbitrary fields but bound both count and size, so a form
          // the site adds later works without a plugin change and a hostile
          // client can't post a megabyte.
          const fields = (payload.fields ?? {}) as Record<string, unknown>
          const entries = Object.entries(fields).slice(0, MAX_FIELDS)
          const cleaned = Object.fromEntries(
            entries.map(([key, value]) => [key, typeof value === "string" ? value.slice(0, MAX_VALUE_LENGTH) : value]),
          )

          const row: SubmissionRow = {
            id: id(),
            form,
            data: encode(cleaned),
            ip: ip || null,
            user_agent: userAgent(c.request as Request) || null,
            read_at: null,
            created_at: now(),
          }

          await ctx.db.execute(from("form_submissions").insert(row))
          return json(c, 201, { received: true, id: row.id })
        }),
      ),

      get(
        "/submissions",
        authed(async c => {
          const limit = Math.min(Math.max(Number(c.query.limit) || 50, 1), 200)
          let query = from("form_submissions")
          if (c.query.form) query = query.where(q => q("form").equals(c.query.form as string))

          const rows = await ctx.db.all<SubmissionRow>(query.orderBy("created_at", "DESC").limit(limit))

          return json(c, 200, {
            data: rows.map(row => {
              const data = decodeObject(row.data)
              return {
                id: row.id,
                form: row.form,
                data,
                // The table panel renders flat columns, so give it something
                // readable without it needing to understand arbitrary fields.
                summary: Object.entries(data)
                  .slice(0, 3)
                  .map(([key, value]) => `${key}: ${String(value).slice(0, 60)}`)
                  .join(" · "),
                ip: row.ip,
                readAt: row.read_at,
                createdAt: row.created_at,
              }
            }),
          })
        }),
      ),

      del(
        "/submissions/:id",
        authed(async c => {
          await ctx.db.execute(
            from("form_submissions")
              .where(q => q("id").equals(c.params.id ?? ""))
              .del(),
          )
          return json(c, 200, { deleted: true })
        }),
      ),
    ]
  },
})
