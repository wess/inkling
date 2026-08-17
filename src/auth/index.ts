import { hash, token, verify } from "atlas/auth"
import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import {
  badRequest,
  conflict,
  del,
  get,
  json,
  parseJson,
  pipeline,
  post,
  tooManyRequests,
  unauthorized,
} from "atlas/server"
import { config } from "../config/index.ts"
import { countRows } from "../db/dialect.ts"
import { body, noStore, requireText } from "../http/index.ts"
import { id } from "../ids/index.ts"
import { sessions, users } from "../schema/index.ts"
import { clientIp, createAudit, createRateLimit, userAgent } from "../security/index.ts"
import { now } from "../time/index.ts"
import { createUser } from "../users/index.ts"
import { auth, requireAuth, requireHuman } from "./guard.ts"

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

const activeUserCount = (db: Connection): Promise<number> =>
  countRows(
    db,
    from("users", "u")
      .select("COUNT(*) as total")
      .where(q => q("u.deleted_at").isNull()),
  )

const publicUser = (row: { id: string; email: string; name: string; role: string; avatar_id: string | null }) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  avatarId: row.avatar_id,
})

export const issueSession = async (
  db: Connection,
  user: { id: string; email: string; name: string; role: string },
  context: { ip: string; userAgent: string },
): Promise<{ token: string; expiresAt: string }> => {
  const jti = id()
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()

  await db.execute(
    from(sessions).insert({
      id: jti,
      user_id: user.id,
      ip: context.ip || null,
      user_agent: context.userAgent || null,
      created_at: now(),
      last_used_at: now(),
      expires_at: expiresAt,
      revoked_at: null,
    }),
  )

  const signed = await token.sign({ sub: user.id, jti, role: user.role }, config.secret, {
    expiresIn: SESSION_TTL_SECONDS,
  })

  return { token: signed, expiresAt }
}

export const authRoutes = (db: Connection): Route[] => {
  const limiter = createRateLimit(db)
  const audit = createAudit(db)
  const guard = pipeline(requireAuth(db))
  // An agent key may say who it is, and nothing else here: ending sessions or
  // changing a password is a person managing their own credentials, and a
  // machine doing it on their behalf is never what was meant.
  const own = pipeline(requireAuth(db), requireHuman)
  const ownJson = pipeline(requireAuth(db), requireHuman, parseJson)

  return [
    get(
      "/auth/setup",
      pipeline()(async c => json(noStore(c), 200, { required: (await activeUserCount(db)) === 0 })),
    ),

    post(
      "/auth/setup",
      pipeline(parseJson)(async c => {
        const input = body(c)
        const email = requireText(input, "email", "Email").toLowerCase()
        const name = requireText(input, "name", "Name")
        const password = requireText(input, "password", "Password")
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw badRequest("Enter a valid email address", { code: "BAD_EMAIL" })
        }
        if (password.length < 12) throw badRequest("Password must be at least 12 characters", { code: "WEAK" })

        const ip = clientIp(c.request as Request & { peerIp?: string })
        const verdict = await limiter.check(`setup:ip:${ip}`, 5, 3600)
        if (!verdict.ok) {
          throw tooManyRequests("Too many setup attempts. Try again shortly.", {
            code: "RATE_LIMITED",
            headers: { "retry-after": String(verdict.retryAfter) },
          })
        }

        let user: Awaited<ReturnType<typeof createUser>>
        try {
          user = await db.transaction(async tx => {
            if ((await activeUserCount(tx)) > 0) {
              throw conflict("This Inkling site has already been set up", { code: "ALREADY_CONFIGURED" })
            }
            // A fixed first-owner id makes simultaneous setup requests race on
            // one primary key instead of quietly creating two owners.
            return createUser(tx, { email, name, password, role: "owner", userId: "inkling-owner" })
          })
        } catch (error) {
          if ((await activeUserCount(db)) > 0) {
            throw conflict("This Inkling site has already been set up", { code: "ALREADY_CONFIGURED" })
          }
          throw error
        }

        const session = await issueSession(db, user, { ip, userAgent: userAgent(c.request as Request) })
        audit.log({ userId: user.id, event: "auth.setup", ip, userAgent: userAgent(c.request as Request) })
        return json(noStore(c), 201, {
          token: session.token,
          expiresAt: session.expiresAt,
          user: publicUser(user),
        })
      }),
    ),

    post(
      "/auth/login",
      pipeline(parseJson)(async c => {
        const email = requireText(body(c), "email", "Email").toLowerCase()
        const password = requireText(body(c), "password", "Password")

        const ip = clientIp(c.request as Request & { peerIp?: string })
        // Two buckets: one stops a single account being ground down, the other
        // stops one host spraying many accounts. Both must pass.
        for (const bucket of [`login:account:${email}`, `login:ip:${ip}`]) {
          const verdict = await limiter.check(bucket, bucket.startsWith("login:ip") ? 30 : 8, 900)
          if (!verdict.ok) {
            audit.log({ event: "auth.login.throttled", metadata: { email }, ip })
            throw tooManyRequests("Too many sign-in attempts. Try again shortly.", {
              code: "RATE_LIMITED",
              headers: { "retry-after": String(verdict.retryAfter) },
            })
          }
        }

        const user = await db.one<{
          id: string
          email: string
          name: string
          role: string
          password_hash: string
          avatar_id: string | null
          deleted_at: string | null
        }>(from(users).where(q => q("email").equals(email)))

        // Same message and roughly the same work whether the account exists or
        // the password is wrong, so login can't be used to enumerate accounts.
        const stored =
          user?.password_hash ?? "$argon2id$v=19$m=65536,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const ok = await verify(password, stored).catch(() => false)

        if (!user || user.deleted_at !== null || !ok) {
          audit.log({ event: "auth.login.failed", metadata: { email }, ip, userAgent: userAgent(c.request as Request) })
          throw unauthorized("Email or password is incorrect", { code: "BAD_CREDENTIALS" })
        }

        await limiter.clear(`login:account:${email}`)
        const session = await issueSession(db, user, { ip, userAgent: userAgent(c.request as Request) })

        await db.execute(
          from(users)
            .update({ last_seen_at: now() })
            .where(q => q("id").equals(user.id)),
        )
        audit.log({ userId: user.id, event: "auth.login", ip, userAgent: userAgent(c.request as Request) })

        return json(noStore(c), 200, { token: session.token, expiresAt: session.expiresAt, user: publicUser(user) })
      }),
    ),

    get(
      "/auth/me",
      guard(async c => {
        const me = auth(c)
        const row = await db.one<{
          id: string
          email: string
          name: string
          role: string
          avatar_id: string | null
        }>(
          from(users)
            .select("id", "email", "name", "role", "avatar_id")
            .where(q => q("id").equals(me.id)),
        )
        if (!row) throw unauthorized("Account is unavailable", { code: "NO_ACCOUNT" })
        return json(noStore(c), 200, publicUser(row))
      }),
    ),

    post(
      "/auth/logout",
      own(async c => {
        const me = auth(c)
        await db.execute(
          from(sessions)
            .update({ revoked_at: now() })
            .where(q => q("id").equals(me.jti)),
        )
        audit.log({ userId: me.id, event: "auth.logout" })
        return json(noStore(c), 200, { ok: true })
      }),
    ),

    get(
      "/auth/sessions",
      own(async c => {
        const me = auth(c)
        const rows = await db.all<{
          id: string
          ip: string | null
          user_agent: string | null
          created_at: string
          last_used_at: string | null
          expires_at: string
        }>(
          from(sessions)
            .select("id", "ip", "user_agent", "created_at", "last_used_at", "expires_at")
            .where(q => q("user_id").equals(me.id))
            .where(q => q("revoked_at").isNull())
            .where(q => q("expires_at").greaterThan(now()))
            .orderBy("last_used_at", "DESC"),
        )

        return json(noStore(c), 200, {
          data: rows.map(row => ({
            id: row.id,
            ip: row.ip,
            userAgent: row.user_agent,
            createdAt: row.created_at,
            lastUsedAt: row.last_used_at,
            expiresAt: row.expires_at,
            current: row.id === me.jti,
          })),
        })
      }),
    ),

    // Sign out everywhere except the session making the request.
    del(
      "/auth/sessions",
      own(async c => {
        const me = auth(c)
        await db.execute(
          from(sessions)
            .update({ revoked_at: now() })
            .where(q => q("user_id").equals(me.id))
            .where(q => q("id").notEquals(me.jti))
            .where(q => q("revoked_at").isNull()),
        )
        audit.log({ userId: me.id, event: "auth.sessions.revokedall" })
        return json(noStore(c), 200, { ok: true })
      }),
    ),

    post(
      "/auth/password",
      ownJson(async c => {
        const me = auth(c)
        const current = requireText(body(c), "currentPassword", "Current password")
        const next = requireText(body(c), "newPassword", "New password")
        if (next.length < 12) throw badRequest("New password must be at least 12 characters", { code: "WEAK" })

        const row = await db.one<{ password_hash: string }>(
          from(users)
            .select("password_hash")
            .where(q => q("id").equals(me.id)),
        )
        if (!row || !(await verify(current, row.password_hash).catch(() => false))) {
          throw unauthorized("Current password is incorrect", { code: "BAD_CREDENTIALS" })
        }

        await db.execute(
          from(users)
            .update({ password_hash: await hash(next), updated_at: now() })
            .where(q => q("id").equals(me.id)),
        )

        // Changing a password ends every other session — that is the point of
        // changing it after a suspected compromise.
        await db.execute(
          from(sessions)
            .update({ revoked_at: now() })
            .where(q => q("user_id").equals(me.id))
            .where(q => q("id").notEquals(me.jti))
            .where(q => q("revoked_at").isNull()),
        )
        audit.log({ userId: me.id, event: "auth.password.changed" })

        return json(noStore(c), 200, { ok: true })
      }),
    ),
  ]
}
