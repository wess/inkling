import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { issueSession } from "../src/auth/index.ts"
import { up } from "../src/migrate/index.ts"
import { sessions } from "../src/schema/index.ts"
import { createUser, userRoutes } from "../src/users/index.ts"

test("admins see only assignable roles and password resets revoke sessions", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  await createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    password: "a secure password",
    role: "owner",
  })
  const admin = await createUser(db, {
    email: "admin@example.com",
    name: "Admin",
    password: "a secure password",
    role: "admin",
  })
  const author = await createUser(db, {
    email: "author@example.com",
    name: "Author",
    password: "a secure password",
    role: "author",
  })
  const adminSession = await issueSession(db, admin, { ip: "127.0.0.1", userAgent: "tests" })
  await issueSession(db, author, { ip: "127.0.0.1", userAgent: "tests" })
  const handle = router(...userRoutes(db))
  const headers = { authorization: `Bearer ${adminSession.token}`, "content-type": "application/json" }

  const list = await handle(new Request("http://localhost/users?limit=100", { headers }))
  const listBody = (await list.json()) as { roles: { value: string }[] }
  expect(listBody.roles.map(role => role.value)).not.toContain("owner")

  expect(
    (
      await handle(
        new Request(`http://localhost/users/${author.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ password: "a different secure password" }),
        }),
      )
    ).status,
  ).toBe(200)
  expect(
    await db.one<{ revoked_at: string | null }>(
      from(sessions)
        .select("revoked_at")
        .where(q => q("user_id").equals(author.id)),
    ),
  ).toMatchObject({ revoked_at: expect.any(String) })
  await db.close()
})
