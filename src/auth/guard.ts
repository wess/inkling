import { token } from "atlas/auth"
import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Conn, PipeFn } from "atlas/server"
import { forbidden, pipe, unauthorized } from "atlas/server"
import { findAgentKey, grantsOf, looksLikeAgentKey, touchAgentKey } from "../agents/verify.ts"
import { config } from "../config/index.ts"
import { sha256 } from "../ids/index.ts"
import { sessions, users } from "../schema/index.ts"
import { clientIp } from "../security/index.ts"
import { now } from "../time/index.ts"
import type { Capability, Role, Scope } from "./roles.ts"
import { isRole } from "./roles.ts"

export type Identity = {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: Role
  readonly jti: string
  // Null for a person, who holds every capability their role allows. A set for
  // an agent key, which holds the intersection of its grants and that role —
  // see `allows` below, which is the only place the two are combined.
  readonly grants: ReadonlySet<Scope> | null
  // Set when the credential is an agent key, so a route can refuse a machine
  // outright and the audit trail can say which key acted.
  readonly agentKeyId: string | null
}

const roleOf = (stored: string): Role => (isRole(stored) ? stored : "viewer")

const liveUser = async (db: Connection, userId: string) => {
  const user = await db.one<{ id: string; email: string; name: string; role: string; deleted_at: string | null }>(
    from(users)
      .select("id", "email", "name", "role", "deleted_at")
      .where(q => q("id").equals(userId)),
  )
  if (!user || user.deleted_at !== null) throw unauthorized("Account is unavailable", { code: "NO_ACCOUNT" })
  return user
}

// Session JWTs are stateless but carry a `jti` bound to a row in `sessions`,
// so logout and "sign out everywhere" can kill a token server-side. Every
// request re-reads the user row too — a demoted or deleted account loses access
// immediately rather than at token expiry.
const sessionIdentity = async (db: Connection, bearer: string): Promise<Identity> => {
  let claims: Record<string, unknown>
  try {
    claims = await token.verify(bearer, config.secret)
  } catch {
    throw unauthorized("Session is invalid or expired", { code: "BAD_TOKEN" })
  }

  const jti = typeof claims.jti === "string" ? claims.jti : ""
  const sub = typeof claims.sub === "string" ? claims.sub : ""
  if (!jti || !sub) throw unauthorized("Session is malformed", { code: "BAD_TOKEN" })

  const session = await db.one<{ id: string; user_id: string; revoked_at: string | null; expires_at: string }>(
    from(sessions)
      .select("id", "user_id", "revoked_at", "expires_at")
      .where(q => q("id").equals(jti)),
  )
  if (!session || session.user_id !== sub || session.revoked_at !== null || session.expires_at <= now()) {
    throw unauthorized("Session has ended", { code: "SESSION_ENDED" })
  }

  const user = await liveUser(db, sub)

  // Fire-and-forget: freshness of last_used_at is not worth blocking on.
  void db
    .execute(
      from(sessions)
        .update({ last_used_at: now() })
        .where(q => q("id").equals(jti)),
    )
    .catch(() => {})

  // The column is TEXT, so a role written by an older build (or by hand) could
  // be anything. Fall back to the least-privileged role rather than trusting an
  // unrecognized string through the capability checks.
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: roleOf(user.role),
    jti,
    grants: null,
    agentKeyId: null,
  }
}

// An agent key is an opaque secret rather than a signed claim, so every check is
// a lookup: the row says whether it still exists, and the account behind it says
// what it is allowed to reach today. Both are re-read per request for the same
// reason a session is — revoking a key or demoting its owner has to bite
// immediately, and a token that carried its own answer could not.
const agentIdentity = async (db: Connection, c: Conn, bearer: string): Promise<Identity> => {
  const row = await findAgentKey(db, await sha256(bearer))
  // One message for "no such key", "revoked", and "expired". Telling them apart
  // describes our own key material to whoever is guessing.
  if (!row || row.revoked_at !== null || row.expires_at <= now()) {
    throw unauthorized("Agent key is not valid", { code: "BAD_AGENT_KEY" })
  }

  const user = await liveUser(db, row.user_id)
  touchAgentKey(db, row.id, clientIp(c.request as Request & { peerIp?: string }))

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: roleOf(user.role),
    jti: row.id,
    grants: grantsOf(row),
    agentKeyId: row.id,
  }
}

export const requireAuth = (db: Connection): PipeFn =>
  pipe(async (c: Conn) => {
    const header = c.headers.get("authorization") ?? ""
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!bearer) throw unauthorized("Sign in to continue", { code: "NO_TOKEN" })

    // The prefix is what tells the two credentials apart. A JWT is three
    // base64url segments and can never begin with `inkagt_`, so the branch is
    // unambiguous rather than a guess followed by a fallback.
    const identity = looksLikeAgentKey(bearer) ? await agentIdentity(db, c, bearer) : await sessionIdentity(db, bearer)

    return { ...c, assigns: { ...c.assigns, auth: identity } }
  })

export const auth = (c: Conn): Identity => c.assigns.auth as Identity

// The one place a role and a grant list are combined. Route code asks this
// rather than `can.x(identity.role)`, because reading the role alone is how an
// agent key would quietly inherit everything the account behind it can do.
export const allows = (identity: Identity, capability: Capability): boolean => {
  if (!capability(identity.role)) return false
  return identity.grants === null || identity.grants.has(capability.scope)
}

// Guards a capability predicate from ./roles rather than a bare role name, so
// route code reads as intent ("can publish") not hierarchy trivia.
export const requireCan =
  (capability: Capability, description: string): PipeFn =>
  (c: Conn) => {
    const identity = auth(c)
    if (!capability(identity.role)) {
      throw forbidden(`You do not have permission to ${description}`, { code: "DENIED" })
    }
    if (identity.grants !== null && !identity.grants.has(capability.scope)) {
      throw forbidden(`This agent key was not granted "${capability.scope}", so it cannot ${description}`, {
        code: "OUT_OF_GRANT",
        details: { scope: capability.scope },
      })
    }
    return c
  }

// Checks a grant on its own, for a route whose *role* bar is enforced some
// other way. Soft-deleting an entry is the case that needs it: an author may bin
// their own work, so the role rule is writeContent plus ownership rather than
// deleteAnyContent — but an agent key granted only `content.write` must still
// not be able to bin anything, and there is no capability predicate that says
// exactly that.
export const requireGrant =
  (scope: Scope, description: string): PipeFn =>
  (c: Conn) => {
    const identity = auth(c)
    if (identity.grants !== null && !identity.grants.has(scope)) {
      throw forbidden(`This agent key was not granted "${scope}", so it cannot ${description}`, {
        code: "OUT_OF_GRANT",
        details: { scope },
      })
    }
    return c
  }

export const granted = (identity: Identity, scope: Scope): boolean =>
  identity.grants === null || identity.grants.has(scope)

// Refuses an agent key outright. For the handful of routes that manage the
// credentials themselves — changing a password, listing or ending sessions,
// minting another key — where a machine acting on a person's behalf is never
// what was meant, whatever it was granted.
export const requireHuman: PipeFn = (c: Conn) => {
  if (auth(c).agentKeyId !== null) {
    throw forbidden(`An agent key cannot do this — sign in as a person`, { code: "AGENT_REFUSED" })
  }
  return c
}
