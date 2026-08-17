import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { agentKeyRoutes } from "../src/agents/index.ts"
import { issueSession } from "../src/auth/index.ts"
import { entryRoutes } from "../src/entries/index.ts"
import { id } from "../src/ids/index.ts"
import { apiKeyRoutes } from "../src/keys/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { contentTypes, users } from "../src/schema/index.ts"
import { settingsRoutes } from "../src/settings/index.ts"
import { now } from "../src/time/index.ts"
import { createUser, userRoutes } from "../src/users/index.ts"

const PASSWORD = "a securely long password"

const site = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const owner = await createUser(db, {
    email: "owner@example.com",
    name: "Owner",
    password: PASSWORD,
    role: "owner",
  })
  const session = await issueSession(db, owner, { ip: "127.0.0.1", userAgent: "tests" })
  const type = {
    id: id(),
    name: "article",
    label: "Article",
    plural_label: "Articles",
    description: null,
    kind: "collection",
    preview_url: null,
    fields: "[]",
    icon: null,
    sort_order: 0,
    owner_plugin: null,
    created_at: now(),
    updated_at: now(),
  }
  await db.execute(from(contentTypes).insert(type))

  const hooks = createHooks()
  const handle = router(
    ...agentKeyRoutes(db),
    ...entryRoutes(db, hooks),
    ...settingsRoutes(db),
    ...apiKeyRoutes(db),
    ...userRoutes(db),
  )

  const as = (credential: string, path: string, init: RequestInit = {}) =>
    handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${credential}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.headers ?? {}),
        },
      }),
    )

  const mint = async (grants: string[], overrides: Record<string, unknown> = {}) => {
    const response = await as(session.token, "/agents", {
      method: "POST",
      body: JSON.stringify({ name: "MCP", password: PASSWORD, grants, ...overrides }),
    })
    return { response, body: (await response.clone().json()) as { key?: string; id?: string } }
  }

  return { db, owner, session, type, as, mint }
}

test("an agent key is bounded by its grants, not by the account behind it", async () => {
  const { db, as, mint, type } = await site()
  const { body } = await mint(["content.read", "content.write"])
  const key = body.key as string
  expect(key.startsWith("inkagt_")).toBe(true)

  // Granted: read and write.
  expect((await as(key, `/types/${type.name}/entries`)).status).toBe(200)
  const created = await as(key, `/types/${type.name}/entries`, {
    method: "POST",
    body: JSON.stringify({ title: "Draft", data: {} }),
  })
  expect(created.status).toBe(201)
  const entry = (await created.json()) as { id: string }

  // Not granted, though the owner behind the key holds every one of these.
  expect((await as(key, `/entries/${entry.id}/publish`, { method: "POST" })).status).toBe(403)
  expect((await as(key, `/entries/${entry.id}`, { method: "DELETE" })).status).toBe(403)
  expect((await as(key, "/settings", { method: "PUT", body: JSON.stringify({ title: "Taken" }) })).status).toBe(403)

  await db.close()
})

test("an agent key cannot reach the administrative surface at all", async () => {
  const { db, as, mint } = await site()

  // The escalation routes are not merely ungranted — they are not grantable, so
  // there is no key that could be minted to reach them.
  for (const scope of ["users.manage", "keys.manage", "webhooks.manage", "plugins.manage", "ai.manage"]) {
    const { response } = await mint([scope])
    expect(response.status).toBe(400)
    expect((await response.json()) as { code: string }).toMatchObject({ code: "BAD_GRANTS" })
  }

  // And a key holding everything it *can* hold still gets nowhere near them.
  const { body } = await mint(["content.read", "content.write", "content.publish", "content.delete", "media.manage"])
  const key = body.key as string
  expect((await as(key, "/users")).status).toBe(403)
  expect((await as(key, "/keys")).status).toBe(403)
  expect(
    (
      await as(key, "/users", {
        method: "POST",
        body: JSON.stringify({ email: "x@y.z", name: "X", password: PASSWORD }),
      })
    ).status,
  ).toBe(403)

  // Including minting itself: a key that could mint another key would be its
  // own renewal, and revoking it would not end the access it had granted.
  expect(
    (
      await as(key, "/agents", {
        method: "POST",
        body: JSON.stringify({ name: "second", password: PASSWORD, grants: ["content.read"] }),
      })
    ).status,
  ).toBe(403)

  await db.close()
})

test("minting needs the password, and grants cannot exceed the minting role", async () => {
  const { db, session, as } = await site()

  const wrongPassword = await as(session.token, "/agents", {
    method: "POST",
    body: JSON.stringify({ name: "MCP", password: "not the password", grants: ["content.read"] }),
  })
  expect(wrongPassword.status).toBe(401)

  const empty = await as(session.token, "/agents", {
    method: "POST",
    body: JSON.stringify({ name: "MCP", password: PASSWORD, grants: [] }),
  })
  expect(empty.status).toBe(400)

  // An author's key cannot carry an editor's capability.
  const author = await createUser(db, {
    email: "author@example.com",
    name: "Author",
    password: PASSWORD,
    role: "author",
  })
  const authorSession = await issueSession(db, author, { ip: "127.0.0.1", userAgent: "tests" })
  const tooHigh = await as(authorSession.token, "/agents", {
    method: "POST",
    body: JSON.stringify({ name: "MCP", password: PASSWORD, grants: ["content.publish"] }),
  })
  expect(tooHigh.status).toBe(400)
  expect((await tooHigh.json()) as { code: string }).toMatchObject({ code: "GRANT_ABOVE_ROLE" })

  await db.close()
})

test("a key narrows when its account is demoted, and dies when it is revoked", async () => {
  const { db, owner, as, mint, type } = await site()
  const { body } = await mint(["content.read", "content.write", "content.publish"])
  const key = body.key as string

  const created = await as(key, `/types/${type.name}/entries`, {
    method: "POST",
    body: JSON.stringify({ title: "Draft", data: {} }),
  })
  const entry = (await created.json()) as { id: string }
  expect((await as(key, `/entries/${entry.id}/publish`, { method: "POST" })).status).toBe(200)

  // The grant survives the demotion; the role does not, and the effective
  // permission is the intersection.
  await db.execute(
    from(users)
      .update({ role: "author" })
      .where(q => q("id").equals(owner.id)),
  )
  expect((await as(key, `/entries/${entry.id}/unpublish`, { method: "POST" })).status).toBe(403)

  // Restoring the role restores the capability without reissuing anything.
  await db.execute(
    from(users)
      .update({ role: "owner" })
      .where(q => q("id").equals(owner.id)),
  )
  expect((await as(key, `/entries/${entry.id}/unpublish`, { method: "POST" })).status).toBe(200)

  await db.close()
})

test("a revoked or expired key is refused", async () => {
  const { db, session, as, mint } = await site()
  const { body } = await mint(["content.read"])
  const key = body.key as string
  expect((await as(key, "/types/article/entries")).status).toBe(200)

  expect((await as(session.token, `/agents/${body.id}`, { method: "DELETE" })).status).toBe(200)
  expect((await as(key, "/types/article/entries")).status).toBe(401)

  const expired = await mint(["content.read"], { expiresAt: new Date(Date.now() - 1000).toISOString() })
  expect(expired.response.status).toBe(400)

  await db.close()
})

test("/agents/me reports what a credential may actually do", async () => {
  const { db, session, as, mint } = await site()
  const { body } = await mint(["content.read", "content.write"])

  const asKey = (await (await as(body.key as string, "/agents/me")).json()) as {
    data: { kind: string; grants: string[] }
  }
  expect(asKey.data.kind).toBe("agent")
  expect(asKey.data.grants.sort()).toEqual(["content.read", "content.write"])

  const asPerson = (await (await as(session.token, "/agents/me")).json()) as {
    data: { kind: string; grants: string[] }
  }
  expect(asPerson.data.kind).toBe("session")
  // A person holds everything their role allows, spelled out for a caller that
  // is deciding what to offer.
  expect(asPerson.data.grants).toContain("users.manage")

  await db.close()
})
