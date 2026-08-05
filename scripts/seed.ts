import { from } from "atlas/db"
import { config } from "../src/config/index.ts"
import { countRows } from "../src/db/dialect.ts"
import { db } from "../src/db/index.ts"
import { up } from "../src/migrate/index.ts"
import { createUser } from "../src/users/index.ts"

await up(db, "./migrations")

const users = await countRows(
  db,
  from("users", "u")
    .select("COUNT(*) as total")
    .where(q => q("u.deleted_at").isNull()),
)

if (users > 0) {
  console.log("Inkling is already set up. No changes were made.")
} else if (!config.bootstrap.email || !config.bootstrap.password) {
  console.log("Open the Inkling admin to create the first owner account.")
  console.log("For unattended setup, set BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD in .env, then run this command again.")
} else {
  if (config.bootstrap.password.length < 12) throw new Error("BOOTSTRAP_PASSWORD must be at least 12 characters")
  await createUser(db, {
    email: config.bootstrap.email,
    name: config.bootstrap.name,
    password: config.bootstrap.password,
    role: "owner",
  })
  console.log(`Created owner account ${config.bootstrap.email}`)
}

await db.close()
