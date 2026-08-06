#!/usr/bin/env bun

//
// Set a user's password from the machine that runs the database.
//
//   bun run password                      # list the accounts on this install
//   bun run password me@example.com       # generate one and print it once
//   bun run password me@example.com <pw>  # or set a specific one
//
// This exists for one situation, and it is not a rare one: a site with a single
// owner, and that owner has lost their password. Every other reset path in
// Inkling needs an account that can already sign in — `PUT /api/users/:id`
// needs an admin, and `POST /auth/password` needs the current password. Setup
// closes permanently once the first user exists, so there is no way back in
// through the browser at all.
//
// The authority here is shell access to the host, which is strictly stronger
// than any credential this could grant: whoever can run this can already read
// DATABASE_URL and open the database directly. So it asks for nothing and
// prompts for nothing — it just needs to be reachable when someone is locked
// out, at 2am, over SSH.

import { hash } from "atlas/auth"
import { from } from "atlas/db"
import { openDb } from "../src/db/index.ts"
import { id } from "../src/ids/index.ts"
import { auditEvents, sessions, users } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"

type Row = { id: string; email: string; name: string; role: string; deleted_at: string | null }

// Long enough that nobody is tempted to keep it, and unambiguous when read off
// a terminal and typed into a browser: no l/1, no O/0.
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const generate = (length = 24): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  // Rejection-free modulo bias is not worth chasing here — the alphabet is 56
  // characters and the bias across 256 is under half a bit per character, on a
  // secret this long and this short-lived.
  return Array.from(bytes, byte => ALPHABET[byte % ALPHABET.length]).join("")
}

// Annotated on the variable, not just the return: TypeScript only treats a
// never-returning function *expression* as terminating control flow when the
// binding itself carries the signature.
const die: (message: string) => never = message => {
  console.error(message)
  process.exit(1)
}

const db = await openDb()

const accounts = await db.all<Row>(from(users).select("id", "email", "name", "role", "deleted_at"))
const live = accounts.filter(account => !account.deleted_at)

const [emailArg, passwordArg] = process.argv.slice(2)

if (!emailArg) {
  if (live.length === 0) {
    console.log("No accounts yet. Open the site and the first visit will offer to create the owner.")
    process.exit(0)
  }
  console.log(`${live.length} account${live.length === 1 ? "" : "s"} on this install:\n`)
  for (const account of live) console.log(`  ${account.role.padEnd(7)} ${account.email}  (${account.name})`)
  console.log("\nPass one of these to set its password:  bun run password <email>")
  process.exit(0)
}

const email = emailArg.toLowerCase()
const user = live.find(account => account.email.toLowerCase() === email)

if (!user) {
  // Named plainly rather than kept vague. Account enumeration is a concern on a
  // public login form, not on a shell the operator already owns — and being coy
  // here would only make a typo look like a broken script.
  const deleted = accounts.find(account => account.email.toLowerCase() === email)
  if (deleted) die(`"${email}" is in the trash. Restore it in the admin before setting a password.`)
  die(`No account with the email "${email}". Run with no arguments to list them.`)
}

const password = passwordArg ?? generate()
if (password.length < 12) die("Password must be at least 12 characters, which is what the API enforces too.")

const stamp = now()

await db.transaction(async tx => {
  await tx.execute(
    from(users)
      .update({ password_hash: await hash(password), updated_at: stamp })
      .where(q => q("id").equals(user.id)),
  )

  // Every existing session dies with the old password. This path is reached
  // after a lockout or a suspected compromise, and in both cases a session
  // someone else already holds is exactly what must not survive.
  await tx.execute(
    from(sessions)
      .update({ revoked_at: stamp })
      .where(q => q("user_id").equals(user.id))
      .where(q => q("revoked_at").isNull()),
  )

  // The history should show this happened out of band, because that is the
  // interesting part: this is the one password change with no actor in the
  // browser and no current password proved.
  await tx.execute(
    from(auditEvents).insert({
      id: id(),
      user_id: user.id,
      event: "auth.password.reset",
      metadata: JSON.stringify({ via: "cli" }),
      ip: null,
      user_agent: null,
      created_at: stamp,
    }),
  )
})

console.log(`\n  ${user.email} (${user.role})`)
if (passwordArg) {
  console.log("\n  Password set. Every session for this account has been signed out.\n")
} else {
  console.log(`\n  New password:  ${password}`)
  console.log("\n  Shown once — it is stored only as a hash. Sign in and change it.")
  console.log("  Every session for this account has been signed out.\n")
}

process.exit(0)
