import { from } from "atlas/db"
import { can, isRole, ROLE_LABELS, ROLES, rank } from "../../auth/roles.ts"
import { rows } from "../../db/dialect.ts"
import { decodeArray, fromBit } from "../../json/index.ts"
import { apiKeys, users, webhooks } from "../../schema/index.ts"
import { checkOutboundUrl } from "../../security/index.ts"
import { parseIso } from "../../time/index.ts"
import { WEBHOOK_EVENTS } from "../../webhooks/index.ts"
import type { Tool } from "./common.ts"
import { fail, list, queued, text } from "./common.ts"

// Who may do what, and what may reach in from outside: people, the delivery
// keys a website reads content with, and the webhooks that tell other systems
// something moved.
//
// Every proposal here is applied by a person who already holds the capability,
// so nothing widens anybody's reach on its own — but each one is a standing
// grant rather than a page of copy, so the descriptions say what it costs.

type UserRow = { id: string; email: string; name: string; role: string; last_seen_at: string | null }
type KeyRow = {
  id: string
  name: string
  prefix: string
  scopes: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}
type WebhookRow = {
  id: string
  name: string
  url: string
  events: string
  active: number
  last_status: number | null
  last_fired_at: string | null
}

export const accessTools: readonly Tool[] = [
  {
    name: "list_people",
    description:
      "List everyone with an account on this site and the role each holds. Roles are a ladder: viewer reads, author writes their own drafts, editor publishes anything, admin manages the site, owner manages other owners.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.manageUsers,
    run: async run => {
      const found = await run.db.all<UserRow>(
        from(users)
          .where(q => q("deleted_at").isNull())
          .orderBy("created_at", "DESC")
          .limit(200),
      )
      return {
        output: {
          people: found.map(row => ({
            id: row.id,
            name: row.name,
            email: row.email,
            role: row.role,
            lastSeenAt: row.last_seen_at,
          })),
          roles: ROLES.map(role => ({ value: role, meaning: ROLE_LABELS[role] })),
        },
      }
    },
  },

  {
    name: "list_delivery_keys",
    description:
      "List the API keys websites use to read this site's published content. The key itself is never stored and cannot be shown again — only a short prefix, so two can be told apart.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.manageKeys,
    run: async run => {
      const found = await run.db.all<KeyRow>(from(apiKeys).orderBy("created_at", "DESC"))
      return {
        output: found.map(row => ({
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          // Empty means every content type, which is the default and worth
          // saying out loud rather than rendering as an empty list.
          contentTypes: decodeArray<string>(row.scopes),
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          expiresAt: row.expires_at,
          revoked: row.revoked_at !== null,
        })),
      }
    },
  },

  {
    name: "list_webhooks",
    description:
      "List the webhooks this site sends — where each one posts, which events it fires on, and how the last delivery went. Use it before adding one that already exists.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.manageWebhooks,
    run: async run => {
      const found = await run.db.all<WebhookRow>(from(webhooks).orderBy("created_at", "DESC"))
      return {
        output: {
          webhooks: found.map(row => ({
            id: row.id,
            name: row.name,
            url: row.url,
            events: decodeArray<string>(row.events),
            active: fromBit(row.active),
            lastStatus: row.last_status,
            lastFiredAt: row.last_fired_at,
          })),
          availableEvents: WEBHOOK_EVENTS,
        },
      }
    },
  },

  {
    name: "propose_person_role",
    description:
      "Propose moving somebody to a different role. Nobody can be given a role above the person applying the change, and nobody can lower their own. Adding a new account is not something you can do — it needs a password typed by a person, so send them to the People screen with open_screen instead.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "From list_people." },
        role: { type: "string", description: "One of: viewer, author, editor, admin, owner." },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["userId", "role", "summary"],
      additionalProperties: false,
    },
    needs: can.manageUsers,
    run: async (run, input) => {
      const row = await run.db.one<UserRow>(
        from(users)
          .where(q => q("id").equals(text(input, "userId")))
          .where(q => q("deleted_at").isNull()),
      )
      if (!row) return fail("No account with that id — call list_people.")

      const role = text(input, "role").toLowerCase()
      if (!isRole(role)) return fail(`\`role\` must be one of: ${ROLES.join(", ")}.`)
      if (role === row.role) return fail(`${row.name} is already ${role}.`)
      // The route refuses this too, but a refusal there arrives after the
      // person has pressed Apply, which reads as a bug rather than a rule.
      if (rank(role) > rank(run.role) || rank(row.role) > rank(run.role)) {
        return fail(`You are working with a ${run.role}, who cannot change someone to or from ${role}.`)
      }

      run.queue({
        kind: "person.role",
        summary: text(input, "summary") || `Make ${row.name} ${role}`,
        userId: row.id,
        personName: row.name,
        from: row.role,
        to: role,
      })

      return queued()
    },
  },

  {
    name: "propose_delivery_key",
    description:
      "Propose a new delivery key — the credential a website uses to read this site's published content. The key is shown once, when it is applied, and never again. Leave `contentTypes` empty for a key that may read everything, or name types to narrow it to one site sharing this install.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'What it is for, e.g. "marketing site".' },
        contentTypes: {
          type: "array",
          items: { type: "string" },
          description: "Content type names this key may read. Empty means all of them.",
        },
        expiresAt: { type: "string", description: "Optional ISO 8601 date-time in the future." },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["name", "summary"],
      additionalProperties: false,
    },
    needs: can.manageKeys,
    run: async (run, input) => {
      const name = text(input, "name")
      if (!name) return fail("A key needs a name — it is the only way to tell two apart later.")

      const scopes = [...new Set(list(input, "contentTypes"))]
      if (scopes.length > 0) {
        const found = await rows<{ name: string }>(
          run.db,
          from("content_types", "ct")
            .select("ct.name as name")
            .where(q => q("ct.name").inList(scopes)),
        )
        const missing = scopes.filter(scope => !found.some(row => row.name === scope))
        if (missing.length > 0) return fail(`These content types do not exist: ${missing.join(", ")}.`)
      }

      const expiresAt = text(input, "expiresAt")
      if (expiresAt) {
        const parsed = parseIso(expiresAt)
        if (!parsed) return fail("`expiresAt` must be an ISO 8601 date-time.")
        if (parsed <= new Date().toISOString()) return fail("`expiresAt` must be in the future.")
      }

      run.queue({
        kind: "key.create",
        summary: text(input, "summary") || `A delivery key for ${name}`,
        payload: { name, scopes, ...(expiresAt ? { expiresAt } : {}) },
      })

      return queued("Shown for review. The key itself appears when it is applied, once — say so.")
    },
  },

  {
    name: "propose_webhook_create",
    description:
      "Propose a new webhook: an address this site posts to whenever content moves. Its signing secret is shown once, when it is applied. Call list_webhooks for the events that exist.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        url: { type: "string", description: "An absolute https URL the receiving system listens on." },
        events: { type: "array", items: { type: "string" }, description: "From list_webhooks." },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["name", "url", "events", "summary"],
      additionalProperties: false,
    },
    needs: can.manageWebhooks,
    run: async (run, input) => {
      const name = text(input, "name")
      if (!name) return fail("A webhook needs a name.")

      const events = list(input, "events")
      const unknown = events.filter(event => !(WEBHOOK_EVENTS as readonly string[]).includes(event))
      if (events.length === 0) return fail(`Name at least one event: ${WEBHOOK_EVENTS.join(", ")}.`)
      if (unknown.length > 0) return fail(`Not an event this site sends: ${unknown.join(", ")}.`)

      // The write path refuses a private or unroutable address, and a refusal
      // there would land on the person rather than on the model.
      const verdict = await checkOutboundUrl(text(input, "url"))
      if (!verdict.ok) return fail(`That URL ${verdict.reason}.`)

      run.queue({
        kind: "webhook.create",
        summary: text(input, "summary") || `Notify ${name}`,
        payload: { name, url: verdict.url.toString(), events, active: true },
      })

      return queued("Shown for review. The signing secret appears when it is applied, once — say so.")
    },
  },

  {
    name: "propose_webhook_update",
    description:
      "Propose changing an existing webhook — a new address, a different set of events, or switching it off. Switching one off is how you stop it without losing its secret.",
    input_schema: {
      type: "object",
      properties: {
        webhookId: { type: "string", description: "From list_webhooks." },
        name: { type: "string" },
        url: { type: "string" },
        events: { type: "array", items: { type: "string" } },
        active: { type: "boolean" },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["webhookId", "summary"],
      additionalProperties: false,
    },
    needs: can.manageWebhooks,
    run: async (run, input) => {
      const row = await run.db.one<WebhookRow>(from(webhooks).where(q => q("id").equals(text(input, "webhookId"))))
      if (!row) return fail("No webhook with that id — call list_webhooks.")

      const patch: Record<string, unknown> = {}
      if (text(input, "name")) patch.name = text(input, "name")
      if (text(input, "url")) {
        const verdict = await checkOutboundUrl(text(input, "url"))
        if (!verdict.ok) return fail(`That URL ${verdict.reason}.`)
        patch.url = verdict.url.toString()
      }
      if (input.events !== undefined) {
        const events = list(input, "events")
        const unknown = events.filter(event => !(WEBHOOK_EVENTS as readonly string[]).includes(event))
        if (unknown.length > 0) return fail(`Not an event this site sends: ${unknown.join(", ")}.`)
        patch.events = events
      }
      if (input.active !== undefined) patch.active = input.active === true
      if (Object.keys(patch).length === 0) return fail("Nothing to change.")

      run.queue({
        kind: "webhook.update",
        summary: text(input, "summary") || `Update ${row.name}`,
        webhookId: row.id,
        webhookName: row.name,
        patch,
        before: { name: row.name, url: row.url, events: decodeArray<string>(row.events), active: fromBit(row.active) },
      })

      return queued()
    },
  },
]
