import { verify } from "atlas/auth"
import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import {
  badRequest,
  del,
  forbidden,
  get,
  json,
  notFound,
  parseJson,
  pipeline,
  post,
  tooManyRequests,
  unauthorized,
} from "atlas/server"
import { auth, requireAuth, requireHuman } from "../auth/guard.ts"
import type { Capability, Scope } from "../auth/roles.ts"
import { can, GRANTABLE_SCOPES, isGrantable, SCOPE_LABELS } from "../auth/roles.ts"
import { body, noStore, requireText } from "../http/index.ts"
import { id, secretToken, sha256 } from "../ids/index.ts"
import { encode } from "../json/index.ts"
import { agentKeys, users } from "../schema/index.ts"
import { clientIp, createAudit, createRateLimit, userAgent } from "../security/index.ts"
import { now, parseIso } from "../time/index.ts"
import type { AgentKeyRow } from "./verify.ts"
import { AGENT_PREFIX, grantsOf } from "./verify.ts"

// Handing a machine the run of the site, on terms.
//
// This is the credential an MCP server, a CI job, or a migration script holds.
// It is emphatically not a delivery key (src/keys), which authenticates a
// website reading published content and carries no user at all — mixing the two
// would mean a leaked website key reaching the admin API, so they are separate
// tables, separate prefixes, and separate guards.
//
// Three rules do the work, and each closes a way an email-and-password in an
// env file failed:
//
//   1. A key can never exceed the account that minted it, and is re-checked
//      against that account's *current* role on every request.
//   2. A key can only ever be granted content capabilities. Everything that
//      widens the blast radius past this install's content — minting keys,
//      registering webhooks, enabling plugins, connecting accounts, creating
//      users — is not in GRANTABLE_SCOPES and so is unreachable from a key,
//      whoever minted it.
//   3. A key is revocable on its own. Cutting off an agent no longer means
//      changing a password and signing every person out.

const MAX_TTL_DAYS = 365
const DEFAULT_TTL_DAYS = 90

const CAPABILITIES: readonly Capability[] = Object.values(can)

const capabilityFor = (scope: Scope): Capability | undefined =>
  CAPABILITIES.find(capability => capability.scope === scope)

const present = (row: AgentKeyRow) => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  grants: [...grantsOf(row)],
  userId: row.user_id,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  lastIp: row.last_ip,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  // Computed rather than stored: a key stops working the moment its deadline
  // passes, and a list that still called it "active" would be lying.
  active: row.revoked_at === null && row.expires_at > now(),
})

// Grants must be named explicitly. There is no "everything" shorthand on
// purpose — a wildcard is how a key ends up holding a capability nobody decided
// to give it, which is the failure this module exists to fix.
const parseGrants = (raw: unknown, role: string): Scope[] => {
  if (!Array.isArray(raw) || raw.some(value => typeof value !== "string")) {
    throw badRequest("`grants` must be an array of capability names", { code: "BAD_GRANTS" })
  }
  const asked = [...new Set(raw as string[])]
  if (asked.length === 0) {
    throw badRequest("An agent key with no grants can do nothing — name what it may do", { code: "BAD_GRANTS" })
  }

  const unknown = asked.filter(scope => !isGrantable(scope))
  if (unknown.length > 0) {
    throw badRequest(
      `Not a capability an agent key may hold: ${unknown.join(", ")}. Allowed: ${GRANTABLE_SCOPES.join(", ")}`,
      { code: "BAD_GRANTS", details: { grantable: GRANTABLE_SCOPES } },
    )
  }

  // The ceiling is the minting account's own role, checked here rather than
  // only at request time so an impossible key is refused instead of being
  // handed over and then 403ing on every call.
  const beyond = (asked as Scope[]).filter(scope => !capabilityFor(scope)?.(role))
  if (beyond.length > 0) {
    throw badRequest(`Your role cannot grant: ${beyond.join(", ")}`, { code: "GRANT_ABOVE_ROLE" })
  }

  return asked as Scope[]
}

const parseExpiry = (raw: unknown): string => {
  if (raw === undefined || raw === null || raw === "") {
    return new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000).toISOString()
  }
  const parsed = parseIso(typeof raw === "string" ? raw : "")
  if (!parsed) throw badRequest("Expiration time is invalid", { code: "BAD_EXPIRY" })
  if (parsed <= now()) throw badRequest("Expiration time must be in the future", { code: "BAD_EXPIRY" })
  const ceiling = new Date(Date.now() + MAX_TTL_DAYS * 86_400_000).toISOString()
  if (parsed > ceiling) throw badRequest(`An agent key may last at most ${MAX_TTL_DAYS} days`, { code: "BAD_EXPIRY" })
  return parsed
}

export const agentKeyRoutes = (db: Connection): Route[] => {
  // Human-only, except for the introspection route at the bottom: a key that
  // could mint another key would be its own renewal, and revoking it would not
  // end the access it had already granted itself. Rule 3 above only holds
  // because this door is closed.
  const read = pipeline(requireAuth(db), requireHuman)
  const write = pipeline(requireAuth(db), requireHuman, parseJson)
  const audit = createAudit(db)
  const limiter = createRateLimit(db)

  return [
    get(
      "/agents",
      read(async c => {
        const identity = auth(c)
        // An admin who manages delivery keys manages these too — somebody has to
        // be able to revoke the key belonging to a colleague who has left.
        const query = can.manageKeys(identity.role)
          ? from(agentKeys)
          : from(agentKeys).where(q => q("user_id").equals(identity.id))
        const rows = await db.all<AgentKeyRow>(query.orderBy("created_at", "DESC"))

        return json(noStore(c), 200, {
          data: rows.map(present),
          // The admin draws its checkboxes from this rather than from a list
          // baked into the bundle, so a capability added to the core cannot go
          // missing from the screen that grants it.
          grantable: GRANTABLE_SCOPES.filter(scope => capabilityFor(scope)?.(identity.role) ?? false).map(scope => ({
            scope,
            label: SCOPE_LABELS[scope],
          })),
          maxDays: MAX_TTL_DAYS,
        })
      }),
    ),

    // What a credential can see about itself, and the one route an agent key may
    // call here. It is why an MCP server can offer only the tools its key will
    // actually honour, rather than discovering the boundary as a 403 halfway
    // through a job.
    get(
      "/agents/me",
      pipeline(requireAuth(db))(async c => {
        const identity = auth(c)
        return json(noStore(c), 200, {
          data: {
            kind: identity.agentKeyId === null ? "session" : "agent",
            name: identity.name,
            email: identity.email,
            role: identity.role,
            // A person holds whatever their role allows, which is what a null
            // grant set means everywhere else. Spelled out as a list here
            // because the caller is a program deciding what to offer.
            grants:
              identity.grants === null
                ? CAPABILITIES.filter(capability => capability(identity.role)).map(capability => capability.scope)
                : [...identity.grants],
          },
        })
      }),
    ),

    // Minting asks for the password again. A session token is a fourteen-day
    // bearer credential sitting in a browser; without this step a stolen one
    // could be traded for a key that outlives the session, survives a logout,
    // and does not appear in "sign out everywhere".
    post(
      "/agents",
      write(async c => {
        const identity = auth(c)
        const input = body(c)
        const name = requireText(input, "name", "Name")
        const password = requireText(input, "password", "Password")

        const ip = clientIp(c.request as Request & { peerIp?: string })
        const verdict = await limiter.check(`agentkey:user:${identity.id}`, 10, 3600)
        if (!verdict.ok) {
          throw tooManyRequests("Too many attempts. Try again shortly.", {
            code: "RATE_LIMITED",
            headers: { "retry-after": String(verdict.retryAfter) },
          })
        }

        const account = await db.one<{ password_hash: string }>(
          from(users)
            .select("password_hash")
            .where(q => q("id").equals(identity.id)),
        )
        if (!account || !(await verify(password, account.password_hash).catch(() => false))) {
          audit.log({
            userId: identity.id,
            event: "agentkey.mint.refused",
            ip,
            userAgent: userAgent(c.request as Request),
          })
          throw unauthorized("Password is incorrect", { code: "BAD_CREDENTIALS" })
        }

        const grants = parseGrants(input.grants, identity.role)
        const expiresAt = parseExpiry(input.expiresAt)
        const plaintext = secretToken(AGENT_PREFIX)

        const row: AgentKeyRow = {
          id: id(),
          name,
          hashed_key: await sha256(plaintext),
          prefix: plaintext.slice(0, AGENT_PREFIX.length + 9),
          grants: encode(grants),
          user_id: identity.id,
          created_at: now(),
          last_used_at: null,
          last_ip: null,
          expires_at: expiresAt,
          revoked_at: null,
        }

        await db.execute(from(agentKeys).insert(row))
        // Awaited rather than fire-and-forget: a credential coming into
        // existence is the one event that must be on the record before the
        // secret is on the wire.
        await audit.log({
          userId: identity.id,
          event: "agentkey.minted",
          metadata: { id: row.id, name, grants, expiresAt },
          ip,
          userAgent: userAgent(c.request as Request),
        })

        // The only time the plaintext is ever returned.
        return json(noStore(c), 201, { ...present(row), key: plaintext })
      }),
    ),

    del(
      "/agents/:id",
      read(async c => {
        const identity = auth(c)
        const row = await db.one<AgentKeyRow>(from(agentKeys).where(q => q("id").equals(c.params.id ?? "")))
        if (!row) throw notFound("Agent key not found")
        if (row.user_id !== identity.id && !can.manageKeys(identity.role)) {
          throw forbidden("That agent key belongs to someone else", { code: "NOT_YOURS" })
        }

        await db.execute(
          from(agentKeys)
            .update({ revoked_at: now() })
            .where(q => q("id").equals(row.id)),
        )
        await audit.log({
          userId: identity.id,
          event: "agentkey.revoked",
          metadata: { id: row.id, name: row.name },
          ip: clientIp(c.request as Request & { peerIp?: string }),
        })

        return json(noStore(c), 200, { revoked: true, id: row.id })
      }),
    ),
  ]
}
