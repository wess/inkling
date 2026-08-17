import type { Connection } from "atlas/db"
import { from, raw } from "atlas/db"
import { config } from "../config/index.ts"
import { id } from "../ids/index.ts"
import { encode } from "../json/index.ts"
import { auditEvents, rateLimits } from "../schema/index.ts"
import { now } from "../time/index.ts"

// atlas/security's limiter and audit logger expect TIMESTAMPTZ/SERIAL columns.
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

// ─── outbound requests ──────────────────────────────────────────────────────

// Anywhere Inkling fetches a URL somebody else chose, it is a request made from
// inside the network Inkling runs in. On a box like ours that reaches the
// Postgres port, the other containers, and — on every cloud host — a metadata
// service that hands out credentials to whoever asks from the right address.
// The receiver's response is reported back (a webhook test returns its status),
// so without this the feature is a port scanner with a signature attached.
//
// An operator with a genuinely internal receiver sets WEBHOOK_ALLOW_PRIVATE.
// That is a decision worth making explicitly rather than a default worth having.

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
]

export const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "::") return true
  if (PRIVATE_V4.some(pattern => pattern.test(host))) return true
  // Unique-local and link-local IPv6, plus the v4-mapped forms of the above.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true
  if (host.startsWith("::ffff:")) return isPrivateHost(host.slice(7))
  return false
}

// Resolves the name too, because "internal.example.com" pointing at 10.0.0.5 is
// the same request as typing the address. It is not airtight — a name can
// resolve differently between this check and the fetch — but it turns the
// obvious version of the attack into an error an operator reads at the moment
// they paste the URL.
export const resolvesPrivate = async (hostname: string): Promise<boolean> => {
  if (isPrivateHost(hostname)) return true
  try {
    const { lookup } = await import("node:dns/promises")
    const addresses = await lookup(hostname, { all: true })
    return addresses.some(entry => isPrivateHost(entry.address))
  } catch {
    // A name that does not resolve cannot be reached either; let the fetch
    // report that in its own words rather than refusing here for the wrong
    // reason.
    return false
  }
}

export type UrlVerdict = { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: string }

export const checkOutboundUrl = async (value: string): Promise<UrlVerdict> => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: "must be an absolute http(s) URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "must use http or https" }
  if (config.allowPrivateNetwork) return { ok: true, url }
  if (await resolvesPrivate(url.hostname)) {
    return {
      ok: false,
      reason: `${url.hostname} is on a private or loopback network. Set WEBHOOK_ALLOW_PRIVATE=true if that is deliberate.`,
    }
  }
  return { ok: true, url }
}
