import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { config } from "../../src/config/index.ts"
import { id, sha256 } from "../../src/ids/index.ts"
import { encode } from "../../src/json/index.ts"
import { now } from "../../src/time/index.ts"

// Turning a beacon into a row. Everything identifying is reduced before it is
// stored: the address becomes a hash that expires nightly, the path loses its
// query string, and the referrer keeps only its host.

// Pageviews are ordinary rows with a reserved name, so one table covers both
// shapes and "views vs events" is a predicate rather than a second schema.
export const VIEW = "view"

export const dayOf = (iso: string): string => iso.slice(0, 10)

export const dayBefore = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

const MAX_PATH = 512
const MAX_NAME = 64
const MAX_META_KEYS = 8
const MAX_META_LENGTH = 200

// Anything that self-identifies as automated. Nowhere near exhaustive, and it
// isn't meant to be — it removes the traffic that would otherwise dominate a
// small site's numbers, and a determined crawler was never going to be caught
// by a user-agent string anyway.
const BOT = /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python-requests|scan/i

export const isBot = (userAgent: string): boolean => BOT.test(userAgent)

// A query string is where campaign tags, session ids, and the occasional
// password-reset token live. None of that belongs in an analytics table, and
// keeping it would scatter one page across hundreds of rows.
export const cleanPath = (value: unknown): string => {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  if (!trimmed) return ""

  // Accept either a path or a full URL, since document.location and a
  // hand-rolled server-side call disagree about which they send.
  const path = trimmed.startsWith("http") ? (URL.parse(trimmed)?.pathname ?? "") : trimmed.split(/[?#]/)[0] || ""
  if (!path.startsWith("/")) return ""

  const withoutSlash = path.length > 1 ? path.replace(/\/+$/, "") : path
  return (withoutSlash || "/").slice(0, MAX_PATH)
}

// Only the host survives. A full referring URL is a tracking vector and reads
// as noise in a top-referrers list; "google.com" is the answer anyone wants.
export const cleanReferrer = (value: unknown, internal: readonly string[]): string => {
  if (typeof value !== "string" || !value.trim()) return ""
  const host = URL.parse(value.trim())?.hostname ?? ""
  if (!host) return ""
  const bare = host.replace(/^www\./, "")
  return internal.includes(bare) ? "" : bare.slice(0, 128)
}

const cleanName = (value: unknown): string => {
  if (typeof value !== "string") return VIEW
  const name = value.trim().toLowerCase().slice(0, MAX_NAME)
  return /^[a-z][a-z0-9.]*$/.test(name) ? name : VIEW
}

// Bounded the same way form submissions are: a site can add a dimension without
// a plugin change, and a hostile client still can't post a megabyte.
const cleanMeta = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_META_KEYS)
      .map(([key, item]) => [key.slice(0, MAX_NAME), String(item ?? "").slice(0, MAX_META_LENGTH)]),
  )
}

// The visitor key. Salted with the install secret and with the current day, so
// it counts uniques within a day and is worthless across days — there is no
// stable identifier to correlate, and no cookie to consent to. The secret never
// leaves the server, so a hash cannot be walked back to an address.
export const visitorKey = async (day: string, ip: string, userAgent: string): Promise<string> =>
  (await sha256(`${config.secret}:${day}:${ip}:${userAgent}`)).slice(0, 32)

export type Beacon = {
  readonly name: string
  readonly path: string
  readonly referrer: string
  readonly meta: Record<string, string>
}

export const readBeacon = (payload: Record<string, unknown>, internal: readonly string[]): Beacon | null => {
  const path = cleanPath(payload.path)
  if (!path) return null
  return {
    name: cleanName(payload.event),
    path,
    referrer: cleanReferrer(payload.referrer, internal),
    meta: cleanMeta(payload.meta),
  }
}

export const record = async (db: Connection, beacon: Beacon, visitor: string): Promise<void> => {
  const at = now()
  await db.execute(
    from("analytics_events").insert({
      id: id(),
      name: beacon.name,
      path: beacon.path,
      referrer: beacon.referrer,
      visitor,
      meta: encode(beacon.meta),
      day: dayOf(at),
      created_at: at,
    }),
  )
}

// Retention runs off the first beacon of each new day rather than a timer.
// There is no job runner here, the table is only ever appended to, and a plugin
// that installs its own setInterval keeps running after it is disabled.
let sweptOn = ""

export const prune = async (db: Connection, retentionDays: number, today: string): Promise<void> => {
  if (sweptOn === today || retentionDays <= 0) return
  sweptOn = today
  await db
    .execute(
      from("analytics_events")
        .where(q => q("day").lessThan(dayBefore(retentionDays)))
        .del(),
    )
    .catch(() => {})
}

// Tests need to observe pruning more than once per process.
export const resetPruneMemo = (): void => {
  sweptOn = ""
}
