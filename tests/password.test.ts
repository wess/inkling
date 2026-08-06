import { expect, test } from "bun:test"
import { verify } from "atlas/auth"
import { connect, from } from "atlas/db"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { auditEvents, sessions, users } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

// scripts/password.ts is the way back in when the only owner has lost their
// password, so what matters is not that it writes a hash — it is that the old
// credential and everything issued under it stop working. Those are separate
// writes, and a reset that rotated the password but left a live session behind
// would look like it worked.
//
// The script is a top-level program that opens its own connection and calls
// process.exit, so the transaction it performs is reproduced here against the
// same schema rather than shelling out to it.

type Db = ReturnType<typeof connect>

// `db.one` is nullable and these rows are written by `ready` a line earlier, so
// the assertion is about reading clearly rather than about the type.
const hashOf = async (db: Db, userId: string): Promise<string> => {
  const row = await db.one<{ password_hash: string }>(
    from(users)
      .select("password_hash")
      .where(q => q("id").equals(userId)),
  )
  if (!row) throw new Error(`no user ${userId}`)
  return row.password_hash
}

const ready = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const owner = await createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    password: "the-original-password",
    role: "owner",
  })
  return { db, owner }
}

const session = async (db: Db, userId: string, revokedAt: string | null = null) => {
  const sessionId = id()
  await db.execute(
    from(sessions).insert({
      id: sessionId,
      user_id: userId,
      ip: null,
      user_agent: null,
      created_at: now(),
      last_used_at: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      revoked_at: revokedAt,
    }),
  )
  return sessionId
}

// The three writes the script makes, in one transaction, as it makes them.
const reset = async (db: Db, userId: string, passwordHash: string) => {
  const stamp = now()
  await db.transaction(async tx => {
    await tx.execute(
      from(users)
        .update({ password_hash: passwordHash, updated_at: stamp })
        .where(q => q("id").equals(userId)),
    )
    await tx.execute(
      from(sessions)
        .update({ revoked_at: stamp })
        .where(q => q("user_id").equals(userId))
        .where(q => q("revoked_at").isNull()),
    )
    await tx.execute(
      from(auditEvents).insert({
        id: id(),
        user_id: userId,
        event: "auth.password.reset",
        metadata: JSON.stringify({ via: "cli" }),
        ip: null,
        user_agent: null,
        created_at: stamp,
      }),
    )
  })
}

test("a reset replaces the password and the old one stops verifying", async () => {
  const { db, owner } = await ready()
  const { hash } = await import("atlas/auth")

  expect(await verify("the-original-password", await hashOf(db, owner.id))).toBe(true)

  await reset(db, owner.id, await hash("a-brand-new-password"))

  const after = await hashOf(db, owner.id)
  expect(await verify("a-brand-new-password", after)).toBe(true)
  // The point of the reset. Without this the lockout is not actually resolved,
  // and worse, whoever caused it may still be holding the old credential.
  expect(await verify("the-original-password", after)).toBe(false)
})

test("every live session for that account is revoked, and only that account's", async () => {
  const { db, owner } = await ready()
  const { hash } = await import("atlas/auth")

  const other = await createUser(db, {
    email: "editor@example.com",
    name: "Editor",
    password: "someone-elses-password",
    role: "editor",
  })

  const live = await session(db, owner.id)
  const alreadyRevoked = await session(db, owner.id, "2020-01-01T00:00:00.000Z")
  const untouched = await session(db, other.id)

  await reset(db, owner.id, await hash("a-brand-new-password"))

  const rows = await db.all<{ id: string; revoked_at: string | null }>(from(sessions).select("id", "revoked_at"))
  const byId = new Map(rows.map(row => [row.id, row.revoked_at]))

  expect(byId.get(live)).not.toBeNull()
  // An already-revoked session keeps its original timestamp rather than being
  // restamped, so the history still says when it actually ended.
  expect(byId.get(alreadyRevoked)).toBe("2020-01-01T00:00:00.000Z")
  // Resetting one account must not sign out the rest of the team.
  expect(byId.get(untouched)).toBeNull()
})

test("the reset is recorded as an out-of-band event", async () => {
  const { db, owner } = await ready()
  const { hash } = await import("atlas/auth")

  await reset(db, owner.id, await hash("a-brand-new-password"))

  const events = await db.all<{ event: string; metadata: string | null; user_id: string | null }>(
    from(auditEvents).select("event", "metadata", "user_id"),
  )
  const entry = events.find(row => row.event === "auth.password.reset")
  expect(entry).toBeDefined()
  expect(entry?.user_id).toBe(owner.id)
  // `via: cli` is the whole value of the record: it distinguishes a change made
  // by someone who proved the current password from one made by someone with
  // shell access and no browser session at all.
  expect(JSON.parse(entry?.metadata ?? "{}").via).toBe("cli")
})
