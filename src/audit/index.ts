import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import { get, json, pipeline } from "atlas/server"
import type { Identity } from "../auth/guard.ts"
import { requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { contains, countRows, paging, rows } from "../db/dialect.ts"
import { decode } from "../json/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { type AuditEntry, createAudit } from "../security/index.ts"

export const registerContentAudit = (db: Connection, hooks: Hooks): void => {
  const audit = createAudit(db)
  const content = (event: string, payload: Omit<AuditEntry, "event">) => audit.log({ ...payload, event })

  // A change made through an agent key is credited to the person the key
  // belongs to — that is the point of binding one to an account. But "Wess
  // published this" and "a program holding Wess's key published this" are
  // different facts, and a trail that cannot tell them apart is the one you
  // most want on the morning something unexpected went live. So the key rides
  // along in the metadata whenever one was used.
  const by = (identity: Identity | null) => (identity?.agentKeyId ? { agentKeyId: identity.agentKeyId } : {})

  hooks.on("entry.afterSave", "core", ({ entry, type, identity, created }) => {
    return content(created ? "content.created" : "content.updated", {
      userId: identity?.id,
      metadata: { id: entry.id, title: entry.title, slug: entry.slug, type: type?.name, ...by(identity) },
    })
  })
  hooks.on("entry.afterPublish", "core", ({ entry, type, identity }) => {
    return content("content.published", {
      userId: identity?.id,
      metadata: { id: entry.id, title: entry.title, slug: entry.slug, type: type?.name, ...by(identity) },
    })
  })
  hooks.on("entry.afterUnpublish", "core", ({ entry, type, identity }) => {
    return content("content.unpublished", {
      userId: identity?.id,
      metadata: { id: entry.id, title: entry.title, slug: entry.slug, type: type?.name, ...by(identity) },
    })
  })
  hooks.on("entry.afterDelete", "core", ({ entry, identity }) => {
    return content("content.deleted", {
      userId: identity?.id,
      metadata: { id: entry.id, title: entry.title, ...by(identity) },
    })
  })
  hooks.on("media.afterUpload", "core", ({ media, identity }) => {
    return content("media.uploaded", {
      userId: identity?.id,
      metadata: { id: media.id, filename: media.filename, ...by(identity) },
    })
  })
  hooks.on("media.afterDelete", "core", ({ media, identity }) => {
    return content("media.deleted", {
      userId: identity?.id,
      metadata: { id: media.id, filename: media.filename, ...by(identity) },
    })
  })
}

export const auditRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db), requireCan(can.manageUsers, "view activity"))

  return [
    get(
      "/audit",
      read(async c => {
        const { limit, offset, page } = paging(c.query, 50, 100)
        let query = from("audit_events", "a")
          .leftJoin("users", "u.id = a.user_id", "u")
          .select("a.id", "a.event", "a.metadata", "a.ip", "a.created_at", "u.name as user_name")
        if (c.query.q) query = query.where(q => q.raw(contains(db, "a.event", c.query.q as string)))

        const events = await rows<{
          id: string
          event: string
          metadata: string | null
          ip: string | null
          created_at: string
          user_name: string | null
        }>(db, query.orderBy("a.created_at", "DESC").limit(limit).offset(offset))

        const totalQuery = from("audit_events", "a").select("COUNT(*) as total")
        const total = await countRows(
          db,
          c.query.q ? totalQuery.where(q => q.raw(contains(db, "a.event", c.query.q as string))) : totalQuery,
        )
        return json(c, 200, {
          data: events.map(event => ({
            id: event.id,
            event: event.event,
            metadata: event.metadata ? decode<Record<string, unknown>>(event.metadata, {}) : null,
            ip: event.ip,
            userName: event.user_name,
            createdAt: event.created_at,
          })),
          meta: { total, page, limit },
        })
      }),
    ),
  ]
}
