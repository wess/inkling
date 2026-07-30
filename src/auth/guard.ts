import { token } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn, PipeFn } from "@atlas/server"
import { forbidden, pipe, unauthorized } from "@atlas/server"
import { config } from "../config/index.ts"
import { sessions, users } from "../schema/index.ts"
import { now } from "../time/index.ts"
import type { Role } from "./roles.ts"
import { atLeast, isRole } from "./roles.ts"

export type Identity = {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: Role
  readonly jti: string
}

// Session JWTs are stateless but carry a `jti` bound to a row in `sessions`,
// so logout and "sign out everywhere" can kill a token server-side. Every
// request re-reads the user row too — a demoted or deleted account loses access
// immediately rather than at token expiry.
export const requireAuth = (db: Connection): PipeFn =>
  pipe(async (c: Conn) => {
    const header = c.headers.get("authorization") ?? ""
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    if (!bearer) throw unauthorized("Sign in to continue", { code: "NO_TOKEN" })

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

    const user = await db.one<{ id: string; email: string; name: string; role: string; deleted_at: string | null }>(
      from(users)
        .select("id", "email", "name", "role", "deleted_at")
        .where(q => q("id").equals(sub)),
    )
    if (!user || user.deleted_at !== null) throw unauthorized("Account is unavailable", { code: "NO_ACCOUNT" })

    // The column is TEXT, so a role written by an older build (or by hand)
    // could be anything. Fall back to the least-privileged role rather than
    // trusting an unrecognized string through the capability checks.
    const role: Role = isRole(user.role) ? user.role : "viewer"

    // Fire-and-forget: freshness of last_used_at is not worth blocking on.
    void db
      .execute(
        from(sessions)
          .update({ last_used_at: now() })
          .where(q => q("id").equals(jti)),
      )
      .catch(() => {})

    const identity: Identity = { id: user.id, email: user.email, name: user.name, role, jti }
    return { ...c, assigns: { ...c.assigns, auth: identity } }
  })

export const auth = (c: Conn): Identity => c.assigns.auth as Identity

export const requireRole =
  (minimum: Role): PipeFn =>
  (c: Conn) => {
    if (!atLeast(auth(c).role, minimum)) {
      throw forbidden(`This action needs the ${minimum} role or higher`, { code: "ROLE_REQUIRED" })
    }
    return c
  }

// Guards a capability predicate from ./roles rather than a bare role name, so
// route code reads as intent ("can publish") not hierarchy trivia.
export const requireCan =
  (capability: (role: string) => boolean, description: string): PipeFn =>
  (c: Conn) => {
    if (!capability(auth(c).role)) throw forbidden(`You do not have permission to ${description}`, { code: "DENIED" })
    return c
  }
