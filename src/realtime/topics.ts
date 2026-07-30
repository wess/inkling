import type { Identity } from "../auth/guard.ts"
import { isHandle } from "../ids/index.ts"
import type { KeyIdentity } from "../keys/index.ts"
import { keyAllows } from "../keys/index.ts"

// Who is holding the socket. The delivery API's boundary does not stop being a
// boundary because the transport changed, so the two audiences are separate
// types and every payload is shaped for one of them explicitly.
export type Audience =
  | { readonly kind: "session"; readonly identity: Identity }
  | { readonly kind: "key"; readonly identity: KeyIdentity }

// Three topic shapes, each a different granularity:
//   site            — instance-wide changes (settings, menus, plugins)
//   content:<type>  — anything happening to entries of one content type
//   entry:<id>      — one entry, including who else is looking at it
export type Topic = string

export const SITE_TOPIC = "site"
export const contentTopic = (typeName: string): Topic => `content:${typeName}`
export const entryTopic = (entryId: string): Topic => `entry:${entryId}`

const parse = (
  topic: Topic,
): { kind: "site" } | { kind: "content"; type: string } | { kind: "entry"; id: string } | null => {
  if (topic === SITE_TOPIC) return { kind: "site" }
  const [head, ...rest] = topic.split(":")
  const tail = rest.join(":")
  if (head === "content" && isHandle(tail)) return { kind: "content", type: tail }
  // Entry ids are uuids; anything else is a probe, not a subscription.
  if (head === "entry" && /^[0-9a-f-]{36}$/i.test(tail)) return { kind: "entry", id: tail }
  return null
}

export const isTopic = (value: unknown): value is Topic =>
  typeof value === "string" && value.length <= 96 && parse(value) !== null

// A delivery key is a website's credential, not an editor's. It may learn that
// published content changed — that is what makes cache invalidation possible —
// but it never gets an entry topic, because activity on a specific entry is
// editorial signal about work that may still be a draft.
export const maySubscribe = (audience: Audience, topic: Topic): boolean => {
  const parsed = parse(topic)
  if (!parsed) return false
  if (audience.kind === "session") return true

  if (parsed.kind === "site") return true
  if (parsed.kind === "content") return keyAllows(audience.identity, parsed.type)
  return false
}

export type Envelope = {
  readonly topic: Topic
  readonly event: string
  readonly data: Record<string, unknown>
}

// Events a key holder is allowed to hear at all. A draft being saved, an entry
// moving to review, a byline changing — none of that is a website's business.
const KEY_EVENTS = new Set(["entry.published", "entry.unpublished", "entry.deleted", "site.settings", "site.menus"])

// Keys get identity and nothing else: enough to invalidate a cached page, not
// enough to reconstruct content they could not have fetched through /content.
// `data` is never included for either audience — a socket is a notification
// channel, and a consumer that wants the entry re-reads it through the API where
// scopes and publication status are enforced on the way out.
export const shapeFor = (audience: Audience, envelope: Envelope): Envelope | null => {
  if (audience.kind === "session") return envelope
  if (!KEY_EVENTS.has(envelope.event)) return null

  const { id, slug, type } = envelope.data
  return {
    topic: envelope.topic,
    event: envelope.event,
    data: {
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof slug === "string" ? { slug } : {}),
      ...(typeof type === "string" ? { type } : {}),
    },
  }
}

// What one viewer looks like to the others on an entry topic. Name and role,
// because the point is "Wess is editing this" — never an email.
export type Viewer = { readonly id: string; readonly name: string; readonly role: string }

export const viewerOf = (audience: Audience): Viewer | null =>
  audience.kind === "session"
    ? { id: audience.identity.id, name: audience.identity.name, role: audience.identity.role }
    : null

// Client -> server frames. Small enough that a hand-rolled reader beats a schema
// library, and every field is validated before it reaches a room.
export type Inbound =
  | { readonly action: "subscribe"; readonly topic: Topic }
  | { readonly action: "unsubscribe"; readonly topic: Topic }
  | { readonly action: "ping" }

export const readInbound = (raw: string): Inbound | null => {
  if (raw.length > 4_096) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null

  const frame = parsed as Record<string, unknown>
  if (frame.action === "ping") return { action: "ping" }
  if ((frame.action === "subscribe" || frame.action === "unsubscribe") && isTopic(frame.topic)) {
    return { action: frame.action, topic: frame.topic }
  }
  return null
}
