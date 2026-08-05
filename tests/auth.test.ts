import { expect, test } from "bun:test"
import { token } from "atlas/auth"
import { connect, from } from "atlas/db"
import { get, json, pipeline, router } from "atlas/server"
import { requireAuth } from "../src/auth/guard.ts"
import { authRoutes } from "../src/auth/index.ts"
import { config } from "../src/config/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { sessions, users } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"

test("a session cannot be reused for a different token subject", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

  const ownerId = id()
  const viewerId = id()
  const addUser = (userId: string, email: string, role: string) =>
    db.execute(
      from(users).insert({
        id: userId,
        email,
        name: role,
        role,
        password_hash: "unused",
        avatar_id: null,
        created_at: now(),
        updated_at: now(),
        last_seen_at: null,
        deleted_at: null,
      }),
    )

  await addUser(ownerId, "owner@example.com", "owner")
  await addUser(viewerId, "viewer@example.com", "viewer")

  const sessionId = id()
  await db.execute(
    from(sessions).insert({
      id: sessionId,
      user_id: viewerId,
      ip: null,
      user_agent: null,
      created_at: now(),
      last_used_at: now(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
    }),
  )

  const forged = await token.sign({ sub: ownerId, jti: sessionId, role: "owner" }, config.secret, { expiresIn: 60 })
  const handle = router(
    get(
      "/private",
      pipeline(requireAuth(db))(c => json(c, 200, { ok: true })),
    ),
  )
  const response = await handle(
    new Request("http://localhost/private", { headers: { authorization: `Bearer ${forged}` } }),
  )

  expect(response.status).toBe(401)
  await db.close()
})

test("a fresh site can create exactly one owner through setup", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const handle = router(...authRoutes(db))
  const call = (body?: Record<string, unknown>) =>
    handle(
      new Request("http://localhost/auth/setup", {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }),
    )

  expect(await (await call()).json()).toEqual({ required: true })

  const created = await call({ name: "Site Owner", email: "owner@example.com", password: "a secure password" })
  expect(created.status).toBe(201)
  const payload = (await created.json()) as any
  expect(payload.token).toBeString()
  expect(payload.user).toMatchObject({ id: "inkling-owner", email: "owner@example.com", role: "owner" })
  expect(await (await call()).json()).toEqual({ required: false })

  const duplicate = await call({ name: "Other Owner", email: "other@example.com", password: "another secure password" })
  expect(duplicate.status).toBe(409)
  expect(
    await db.all(
      from(users)
        .select("id")
        .where(q => q("deleted_at").isNull()),
    ),
  ).toHaveLength(1)

  await Bun.sleep(0)
  await db.close()
})
