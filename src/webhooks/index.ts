import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import { badRequest, del, get, json, notFound, parseJson, pipeline, post, put } from "atlas/server"
import { requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { body, optionalText, requireText } from "../http/index.ts"
import { id, secretToken } from "../ids/index.ts"
import { decodeArray, encode, fromBit } from "../json/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { webhooks } from "../schema/index.ts"
import { checkOutboundUrl } from "../security/index.ts"
import { now } from "../time/index.ts"

export const WEBHOOK_EVENTS = [
  "entry.created",
  "entry.updated",
  "entry.published",
  "entry.unpublished",
  "entry.deleted",
  "media.uploaded",
  "media.deleted",
] as const

type WebhookRow = {
  id: string
  name: string
  url: string
  events: string
  secret: string
  active: number
  created_at: string
  last_status: number | null
  last_fired_at: string | null
}

const present = (row: WebhookRow) => ({
  id: row.id,
  name: row.name,
  url: row.url,
  events: decodeArray<string>(row.events),
  active: fromBit(row.active),
  createdAt: row.created_at,
  lastStatus: row.last_status,
  lastFiredAt: row.last_fired_at,
})

const sign = async (payload: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

// One place every outbound delivery goes through, so the guards cannot be on the
// test route and missing from the real one.
//
// `redirect: "manual"` is the load-bearing half: a URL that passes the check at
// creation is free to answer with a 302 to 169.254.169.254, and a followed
// redirect would make the whole check theatre. A receiver that wants to move
// should say so to whoever configured it.
const deliver = async (url: string, payload: string, headers: Record<string, string>): Promise<Response | null> => {
  // Re-resolve at delivery time as well as when the webhook is saved. DNS can
  // change between those two moments; an old public hostname must not become a
  // route into loopback, a sibling container, or cloud metadata by surprise.
  // `redirect: "manual"` below closes the other half of the same gap.
  const verdict = await checkOutboundUrl(url)
  if (!verdict.ok) return null
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
}

// Deliveries are best-effort and never block the request that triggered them.
// A receiver that is slow or down must not turn a successful publish into a 500.
export const dispatch = async (db: Connection, event: string, data: unknown): Promise<void> => {
  const hooks = await db.all<WebhookRow>(from(webhooks).where(q => q("active").equals(1)))
  if (hooks.length === 0) return

  const payload = JSON.stringify({ event, data, timestamp: now() })

  await Promise.allSettled(
    hooks
      .filter(hook => decodeArray<string>(hook.events).includes(event))
      .map(async hook => {
        const signature = await sign(payload, hook.secret)
        const response = await deliver(hook.url, payload, {
          "x-inkling-event": event,
          "x-inkling-signature": `sha256=${signature}`,
        })

        await db
          .execute(
            from(webhooks)
              .update({ last_status: response?.status ?? 0, last_fired_at: now() })
              .where(q => q("id").equals(hook.id)),
          )
          .catch(() => {})
      }),
  )
}

// Bridges the internal hook bus onto outbound webhooks, so core code emits one
// vocabulary and subscribers receive another without either knowing about the
// other. Registered under the reserved "core" plugin name.
export const registerWebhookBridge = (db: Connection, hooks: Hooks): void => {
  hooks.on("entry.afterSave", "core", ({ entry, type, created }) => {
    void dispatch(db, created ? "entry.created" : "entry.updated", { id: entry.id, type: type?.name, slug: entry.slug })
  })
  hooks.on("entry.afterPublish", "core", ({ entry, type }) => {
    void dispatch(db, "entry.published", { id: entry.id, type: type?.name, slug: entry.slug })
  })
  hooks.on("entry.afterUnpublish", "core", ({ entry, type }) => {
    void dispatch(db, "entry.unpublished", { id: entry.id, type: type?.name, slug: entry.slug })
  })
  hooks.on("entry.afterDelete", "core", ({ entry }) => {
    void dispatch(db, "entry.deleted", { id: entry.id, slug: entry.slug })
  })
  hooks.on("media.afterUpload", "core", ({ media }) => {
    void dispatch(db, "media.uploaded", { id: media.id, filename: media.filename, url: media.url })
  })
  hooks.on("media.afterDelete", "core", ({ media }) => {
    void dispatch(db, "media.deleted", { id: media.id })
  })
}

export const webhookRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db), requireCan(can.manageWebhooks, "manage webhooks"))
  const write = pipeline(requireAuth(db), requireCan(can.manageWebhooks, "manage webhooks"), parseJson)

  const parseEvents = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.some(v => typeof v !== "string")) {
      throw badRequest("events must be an array of event names", { code: "BAD_EVENTS" })
    }
    const unknown = (raw as string[]).filter(e => !(WEBHOOK_EVENTS as readonly string[]).includes(e))
    if (unknown.length > 0) {
      throw badRequest(`Unknown event${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`, { code: "BAD_EVENTS" })
    }
    return raw as string[]
  }

  const parseUrl = async (value: string): Promise<string> => {
    const verdict = await checkOutboundUrl(value)
    if (!verdict.ok) throw badRequest(`url ${verdict.reason}`, { code: "BAD_URL" })
    return verdict.url.toString()
  }

  return [
    get(
      "/webhooks",
      read(async c => {
        const rows = await db.all<WebhookRow>(from(webhooks).orderBy("created_at", "DESC"))
        return json(c, 200, { data: rows.map(present), events: WEBHOOK_EVENTS })
      }),
    ),

    post(
      "/webhooks",
      write(async c => {
        const input = body(c)
        const row: WebhookRow = {
          id: id(),
          name: requireText(input, "name", "Name"),
          url: await parseUrl(requireText(input, "url", "URL")),
          events: encode(parseEvents(input.events ?? [])),
          secret: secretToken("whsec"),
          active: input.active === false ? 0 : 1,
          created_at: now(),
          last_status: null,
          last_fired_at: null,
        }

        await db.execute(from(webhooks).insert(row))
        // The signing secret is returned once so the receiver can be configured.
        return json(c, 201, { ...present(row), secret: row.secret })
      }),
    ),

    put(
      "/webhooks/:id",
      write(async c => {
        const row = await db.one<WebhookRow>(from(webhooks).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Webhook not found")

        const input = body(c)
        const changes: Record<string, unknown> = {}
        if (input.name !== undefined) changes.name = optionalText(input, "name") ?? row.name
        if (input.url !== undefined) changes.url = await parseUrl(requireText(input, "url", "URL"))
        if (input.events !== undefined) changes.events = encode(parseEvents(input.events))
        if (input.active !== undefined) changes.active = input.active ? 1 : 0

        if (Object.keys(changes).length > 0) {
          await db.execute(
            from(webhooks)
              .update(changes)
              .where(q => q("id").equals(row.id)),
          )
        }
        return json(c, 200, present({ ...row, ...changes } as WebhookRow))
      }),
    ),

    del(
      "/webhooks/:id",
      read(async c => {
        const row = await db.one<WebhookRow>(from(webhooks).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Webhook not found")
        await db.execute(
          from(webhooks)
            .where(q => q("id").equals(row.id))
            .del(),
        )
        return json(c, 200, { deleted: true })
      }),
    ),

    post(
      "/webhooks/:id/test",
      read(async c => {
        const row = await db.one<WebhookRow>(from(webhooks).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Webhook not found")

        const payload = JSON.stringify({ event: "ping", data: { webhookId: row.id }, timestamp: now() })
        const signature = await sign(payload, row.secret)
        const response = await deliver(row.url, payload, {
          "x-inkling-event": "ping",
          "x-inkling-signature": `sha256=${signature}`,
        })

        await db.execute(
          from(webhooks)
            .update({ last_status: response?.status ?? 0, last_fired_at: now() })
            .where(q => q("id").equals(row.id)),
        )

        return json(c, 200, { delivered: response !== null, status: response?.status ?? 0 })
      }),
    ),
  ]
}
