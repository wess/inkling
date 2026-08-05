import { from } from "atlas/db"
import { badRequest, get, json, pipeline } from "atlas/server"
import { rows as query } from "../../src/db/dialect.ts"
import { cors } from "../../src/http/index.ts"
import { decodeObject } from "../../src/json/index.ts"
import { requireApiKey } from "../../src/keys/index.ts"
import { definePlugin } from "../../src/plugins/define.ts"

// Demonstrates a plugin-owned content type plus a delivery-side route. The
// consuming site calls /ext/redirects/resolve?path=… before rendering a 404,
// so editors can fix a broken link without a deploy.

type RedirectRow = { data: string; status: string }

export default definePlugin({
  name: "redirects",
  version: "1.0.0",
  label: "Redirects",
  description: "Manages URL redirects, resolvable from the front end before serving a 404.",
  author: "Inkling",

  contentTypes: [
    {
      name: "redirect",
      label: "Redirect",
      pluralLabel: "Redirects",
      description: "Send an old path to a new one.",
      icon: "corner-up-right",
      sortOrder: 90,
      fields: [
        { key: "source", type: "text", label: "From path", required: true, help: "e.g. /old-page" },
        { key: "target", type: "url", label: "To", required: true, help: "A path or absolute URL" },
        {
          key: "code",
          type: "select",
          label: "Status",
          default: "301",
          options: [
            { value: "301", label: "301 — permanent" },
            { value: "302", label: "302 — temporary" },
          ],
        },
      ],
    },
  ],

  panels: [
    { id: "redirects", label: "Redirects", icon: "corner-up-right", kind: "collection", contentType: "redirect" },
  ],

  routes: ctx => [
    // Same auth posture as the delivery API — a site already holds a key, and
    // it keeps redirect targets from being enumerable by anyone.
    get(
      "/resolve",
      pipeline(
        cors,
        requireApiKey(ctx.db),
      )(async c => {
        const path = (c.query.path ?? "").trim()
        if (!path) throw badRequest("Pass ?path=/the/old/path", { code: "NO_PATH" })

        // Redirects are ordinary published entries of the plugin's own type.
        const candidates = await query<RedirectRow>(
          ctx.db,
          from("entries", "e")
            .join("content_types", "ct.id = e.content_type_id", "ct")
            .select("e.data", "e.status")
            .where(q => q("ct.name").equals("redirect"))
            .where(q => q("e.status").equals("published"))
            .where(q => q("e.deleted_at").isNull())
            .limit(500),
        )

        const normalize = (value: string) => (value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value)
        const wanted = normalize(path)

        for (const row of candidates) {
          const data = decodeObject(row.data)
          if (typeof data.source === "string" && normalize(data.source) === wanted) {
            return json(c, 200, {
              data: { target: String(data.target ?? "/"), code: Number(data.code ?? 301) || 301 },
            })
          }
        }

        return json(c, 200, { data: null })
      }),
    ),
  ],
})
