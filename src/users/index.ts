import { hash } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Route } from "@atlas/server"
import {
  badRequest,
  conflict,
  del,
  forbidden,
  get,
  json,
  notFound,
  parseJson,
  pipeline,
  post,
  put,
} from "@atlas/server"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can, isRole, ROLE_LABELS, rank } from "../auth/roles.ts"
import { countRows, paging } from "../db/dialect.ts"
import { body, optionalText, requireText } from "../http/index.ts"
import { id } from "../ids/index.ts"
import { sessions, users } from "../schema/index.ts"
import { now } from "../time/index.ts"

type UserRow = {
  id: string
  email: string
  name: string
  role: string
  avatar_id: string | null
  created_at: string
  updated_at: string
  last_seen_at: string | null
  deleted_at: string | null
}

const present = (row: UserRow) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  avatarId: row.avatar_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
})

export const createUser = async (
  db: Connection,
  input: { email: string; name: string; password: string; role: string; userId?: string },
): Promise<UserRow> => {
  const timestamp = now()
  const row: UserRow = {
    id: input.userId ?? id(),
    email: input.email.toLowerCase(),
    name: input.name,
    role: input.role,
    avatar_id: null,
    created_at: timestamp,
    updated_at: timestamp,
    last_seen_at: null,
    deleted_at: null,
  }

  await db.execute(from(users).insert({ ...row, password_hash: await hash(input.password) }))
  return row
}

export const userRoutes = (db: Connection): Route[] => {
  const read = pipeline(requireAuth(db), requireCan(can.manageUsers, "manage users"))
  const write = pipeline(requireAuth(db), requireCan(can.manageUsers, "manage users"), parseJson)

  // An admin must not be able to create or promote someone above themselves,
  // or edit an account that outranks them — otherwise "admin" is really "owner".
  const assertOutranks = (actorRole: string, targetRole: string, action: string): void => {
    if (rank(actorRole) < rank(targetRole)) {
      throw forbidden(`You cannot ${action} someone with the ${targetRole} role`, { code: "OUTRANKED" })
    }
  }

  return [
    get(
      "/users",
      read(async c => {
        const { limit, offset, page } = paging(c.query)
        const query = from("users").where(q => q("deleted_at").isNull())
        const rows = await db.all<UserRow>(query.orderBy("created_at", "DESC").limit(limit).offset(offset))

        return json(c, 200, {
          data: rows.map(present),
          meta: { total: await countRows(db, query.select("COUNT(*) as total")), page, limit },
          roles: Object.entries(ROLE_LABELS)
            .filter(([value]) => rank(value) <= rank(auth(c).role))
            .map(([value, label]) => ({ value, label })),
        })
      }),
    ),

    post(
      "/users",
      write(async c => {
        const input = body(c)
        const email = requireText(input, "email", "Email").toLowerCase()
        const name = requireText(input, "name", "Name")
        const password = requireText(input, "password", "Password")
        const role = optionalText(input, "role") ?? "editor"

        if (password.length < 12) throw badRequest("Password must be at least 12 characters", { code: "WEAK" })
        if (!isRole(role))
          throw badRequest(`Role must be one of: ${Object.keys(ROLE_LABELS).join(", ")}`, { code: "BAD_ROLE" })
        assertOutranks(auth(c).role, role, "create")

        const existing = await db.one(from(users).where(q => q("email").equals(email)))
        if (existing) throw conflict("That email is already registered", { code: "DUPLICATE" })

        const row = await createUser(db, { email, name, password, role })
        return json(c, 201, present(row))
      }),
    ),

    put(
      "/users/:id",
      write(async c => {
        const row = await db.one<UserRow>(
          from(users)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNull()),
        )
        if (!row) throw notFound("User not found")

        const actor = auth(c)
        assertOutranks(actor.role, row.role, "edit")

        const input = body(c)
        const changes: Record<string, unknown> = { updated_at: now() }
        let revokeSessions = false

        if (input.name !== undefined) changes.name = requireText(input, "name", "Name")
        if (input.avatarId !== undefined) changes.avatar_id = optionalText(input, "avatarId")

        if (input.role !== undefined) {
          const role = requireText(input, "role", "Role")
          if (!isRole(role)) throw badRequest("Unknown role", { code: "BAD_ROLE" })
          assertOutranks(actor.role, role, "assign")
          if (row.id === actor.id && rank(role) < rank(actor.role)) {
            throw badRequest("You cannot lower your own role — ask another admin", { code: "SELF_DEMOTE" })
          }
          changes.role = role
        }

        if (input.password !== undefined) {
          const password = requireText(input, "password", "Password")
          if (password.length < 12) throw badRequest("Password must be at least 12 characters", { code: "WEAK" })
          changes.password_hash = await hash(password)
          revokeSessions = true
        }

        await db.transaction(async tx => {
          await tx.execute(
            from(users)
              .update(changes)
              .where(q => q("id").equals(row.id)),
          )
          // An admin-forced password change ends that user's sessions in the
          // same transaction as the new hash.
          if (revokeSessions) {
            await tx.execute(
              from(sessions)
                .update({ revoked_at: now() })
                .where(q => q("user_id").equals(row.id))
                .where(q => q("revoked_at").isNull()),
            )
          }
        })
        const updated = await db.one<UserRow>(from(users).where(q => q("id").equals(row.id)))
        return json(c, 200, present(updated as UserRow))
      }),
    ),

    del(
      "/users/:id",
      pipeline(
        requireAuth(db),
        requireCan(can.manageUsers, "manage users"),
      )(async c => {
        const row = await db.one<UserRow>(
          from(users)
            .where(q => q("id").equals(c.params.id ?? ""))
            .where(q => q("deleted_at").isNull()),
        )
        if (!row) throw notFound("User not found")

        const actor = auth(c)
        if (row.id === actor.id) throw badRequest("You cannot delete your own account", { code: "SELF_DELETE" })
        assertOutranks(actor.role, row.role, "delete")

        // Refuse to remove the last owner — otherwise the instance becomes
        // permanently unadministerable.
        if (row.role === "owner") {
          const owners = await countRows(
            db,
            from("users", "u")
              .select("COUNT(*) as total")
              .where(q => q("u.role").equals("owner"))
              .where(q => q("u.deleted_at").isNull()),
          )
          if (owners <= 1) {
            throw conflict("This is the only owner account — promote someone else first", { code: "LAST_OWNER" })
          }
        }

        await db.execute(
          from(users)
            .update({ deleted_at: now(), updated_at: now() })
            .where(q => q("id").equals(row.id)),
        )
        await db.execute(
          from(sessions)
            .update({ revoked_at: now() })
            .where(q => q("user_id").equals(row.id))
            .where(q => q("revoked_at").isNull()),
        )

        return json(c, 200, { deleted: true, id: row.id })
      }),
    ),
  ]
}
