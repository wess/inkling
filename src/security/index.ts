import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { config } from "../config/index.ts"
import { id } from "../ids/index.ts"
import { encode } from "../json/index.ts"
import { auditEvents, rateLimits } from "../schema/index.ts"
import { now } from "../time/index.ts"

// @atlas/security's limiter and audit logger expect TIMESTAMPTZ/SERIAL columns.
// Inkling's schema is deliberately on TEXT ISO timestamps and TEXT uuids so one
// migration set covers both dialects, so the two are reimplemented here against
// that convention rather than carrying a second timestamp style.

export type RateVerdict = { readonly ok: boolean; readonly remaining: number; readonly retryAfter: number }

export const createRateLimit = (db: Connection) => ({
  // Fixed-window counter. `limit` requests per `windowSeconds` per bucket.
  //
  // One statement, deliberately. Reading the row and then writing it back lets
  // two concurrent requests both observe "no row yet" and both settle the
  // counter at 1, so the effective limit drifts above the configured one under
  // exactly the load a limiter exists to handle. The upsert below decides
  // inside the database instead: on conflict it either resets an expired window
  // or increments a live one, and RETURNING hands back the value this caller
  // actually claimed.
  check: async (bucket: string, limit: number, windowSeconds: number): Promise<RateVerdict> => {
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString()
    const startedAt = now()

    const [claimed] = await db.execute<{ count: number | string; window_started_at: string }>(
      from(rateLimits)
        .insert({ bucket, count: 1, window_started_at: startedAt })
        .onConflict({
          target: ["bucket"],
          action: "update",
          // Nothing comes from EXCLUDED — both columns are conditional on
          // whether the stored window has expired, which EXCLUDED can't express.
          updateColumns: [],
          setExtra: {
            count: raw(`CASE WHEN rate_limits.window_started_at <= $1 THEN 1 ELSE rate_limits.count + 1 END`, cutoff),
            window_started_at: raw(
              `CASE WHEN rate_limits.window_started_at <= $1 THEN $2 ELSE rate_limits.window_started_at END`,
              cutoff,
              startedAt,
            ),
          },
        })
        .returning("count", "window_started_at"),
    )

    // A driver that declines to return the row leaves us no basis to deny on;
    // failing open matches the rest of this module, which never lets limiter
    // trouble become a request failure.
    if (!claimed) return { ok: true, remaining: limit - 1, retryAfter: 0 }

    const count = Number(claimed.count)
    if (count > limit) {
      const elapsed = (Date.now() - new Date(claimed.window_started_at).getTime()) / 1000
      return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil(windowSeconds - elapsed)) }
    }

    return { ok: true, remaining: Math.max(0, limit - count), retryAfter: 0 }
  },

  // Called after a successful login so a user who eventually gets it right
  // isn't left throttled by their earlier typos.
  clear: async (bucket: string): Promise<void> => {
    await db
      .execute(
        from(rateLimits)
          .where(q => q("bucket").equals(bucket))
          .del(),
      )
      .catch(() => {})
  },

  sweep: async (olderThanSeconds: number): Promise<void> => {
    const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString()
    await db
      .execute(
        from(rateLimits)
          .where(q => q("window_started_at").lessThan(cutoff))
          .del(),
      )
      .catch(() => {})
  },
})

export type AuditEntry = {
  readonly userId?: string | null
  readonly event: string
  readonly metadata?: unknown
  readonly ip?: string | null
  readonly userAgent?: string | null
}

export const createAudit = (db: Connection) => ({
  // Never throws. Callers may await durable recording when order matters, or
  // fire-and-forget when an audit write must not delay the request.
  log: async (entry: AuditEntry): Promise<void> => {
    await db
      .execute(
        from(auditEvents).insert({
          id: id(),
          user_id: entry.userId ?? null,
          event: entry.event,
          metadata: entry.metadata === undefined ? null : encode(entry.metadata),
          ip: entry.ip ?? null,
          user_agent: entry.userAgent ?? null,
          created_at: now(),
        }),
      )
      .catch(() => {})
  },
})

const parseCidr = (entry: string): { base: bigint; bits: number } | null => {
  const [addr, maskRaw] = entry.split("/")
  if (!addr) return null
  const parts = addr.split(".")
  if (parts.length !== 4) return null
  let base = 0n
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    base = (base << 8n) | BigInt(octet)
  }
  const bits = maskRaw === undefined ? 32 : Number(maskRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null
  return { base, bits }
}

const inCidr = (ip: string, cidr: { base: bigint; bits: number }): boolean => {
  const parsed = parseCidr(ip)
  if (!parsed) return false
  const mask = cidr.bits === 0 ? 0n : (~0n << BigInt(32 - cidr.bits)) & 0xffffffffn
  return (parsed.base & mask) === (cidr.base & mask)
}

const TRUSTED = config.trustedProxies.map(parseCidr).filter((v): v is { base: bigint; bits: number } => v !== null)

// X-Forwarded-For is attacker-controlled unless the request actually arrived
// from a proxy we configured. Rate-limit buckets key on this, so trusting it
// blindly would let a client mint unlimited buckets.
export const clientIp = (req: Request & { peerIp?: string }): string => {
  const peer = req.peerIp ?? ""
  const trusted = peer !== "" && TRUSTED.some(cidr => inCidr(peer, cidr))
  if (!trusted) return peer

  const forwarded = req.headers.get("x-forwarded-for") ?? ""
  const first = forwarded.split(",")[0]?.trim()
  return first || req.headers.get("x-real-ip") || peer
}

export const userAgent = (req: Request): string => (req.headers.get("user-agent") ?? "").slice(0, 512)
