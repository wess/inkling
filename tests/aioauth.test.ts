import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { aiPublicRoutes, aiRoutes, resolveCredential } from "../src/ai/index.ts"
import { open, seal } from "../src/ai/secrets.ts"
import { issueSession } from "../src/auth/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { aiCredentials } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"

// OAuth adds a second way to connect, a token that expires, and a public route.
// These cover the parts of that which can go wrong quietly: a token leaking into
// a response, a forged callback, and an expired grant reading as a broken
// install rather than as one to reconnect.

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

  const admin = await createUser(db, {
    email: "admin@example.com",
    name: "Admin",
    password: "a secure password",
    role: "admin",
  })
  const session = await issueSession(db, admin, { ip: "127.0.0.1", userAgent: "tests" })

  const handle = router(...aiRoutes(db))
  const publicHandle = router(...aiPublicRoutes(db, "/"))

  return { db, handle, publicHandle, adminId: admin.id, token: session.token }
}

// An OAuth row as the callback would have written it. Built directly so the
// tests do not need a provider to talk to.
const storeOauthRow = async (
  db: Awaited<ReturnType<typeof setup>>["db"],
  options: { accessToken: string; refreshToken?: string; expiresAt?: string | null },
) => {
  const access = await seal(options.accessToken)
  const refresh = options.refreshToken ? await seal(options.refreshToken) : null
  await db.execute(
    from(aiCredentials).insert({
      id: id(),
      provider: "anthropic",
      label: "Claude — someone@example.com",
      model: "claude-opus-5",
      base_url: null,
      ciphertext: access.ciphertext,
      iv: access.iv,
      hint: access.hint,
      is_default: 1,
      created_by: null,
      created_at: now(),
      updated_at: now(),
      last_used_at: null,
      revoked_at: null,
      auth_kind: "oauth",
      refresh_ciphertext: refresh?.ciphertext ?? null,
      refresh_iv: refresh?.iv ?? null,
      expires_at: options.expiresAt === undefined ? null : options.expiresAt,
      scope: "user:inference",
      account: "someone@example.com",
    }),
  )
}

test("an OAuth connection resolves like a key but is labelled as a bearer token", async () => {
  const { db } = await setup()
  await storeOauthRow(db, { accessToken: "oat-notarealtoken-abcd" })

  const resolved = await resolveCredential(db)
  expect(resolved?.secret).toBe("oat-notarealtoken-abcd")
  // The distinction has to survive this far: an access token rides
  // `Authorization: Bearer`, an API key rides `x-api-key`.
  expect(resolved?.authKind).toBe("oauth")

  await db.close()
})

test("neither the access token nor the refresh token appears in any response", async () => {
  const { db, handle, token } = await setup()
  await storeOauthRow(db, { accessToken: "oat-accesssecret-1234", refreshToken: "ort-refreshsecret-5678" })

  const listed = await handle(
    new Request("http://localhost/ai/credentials", { headers: { authorization: `Bearer ${token}` } }),
  )
  const body = await listed.text()

  expect(body).not.toContain("accesssecret")
  expect(body).not.toContain("refreshsecret")
  // What it does carry is enough to tell two connections apart.
  expect(body).toContain("someone@example.com")
  expect(body).toContain("oauth")

  await db.close()
})

test("an expired grant with nothing to refresh reads as not configured, not as an error", async () => {
  const { db } = await setup()
  await storeOauthRow(db, {
    accessToken: "oat-expired-abcd",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })

  // No refresh token and no configured client, so there is no way back — which
  // must surface as "reconnect this provider" rather than as a thrown request.
  expect(await resolveCredential(db)).toBeNull()

  await db.close()
})

test("a key cannot be pasted into an OAuth connection", async () => {
  const { db, handle, token } = await setup()
  await storeOauthRow(db, { accessToken: "oat-notarealtoken-abcd" })

  type Sealed = { id: string; ciphertext: string; iv: string }
  const before = (await db.one<Sealed>(from(aiCredentials))) as Sealed

  const response = await handle(
    new Request(`http://localhost/ai/credentials/${before.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ key: "sk-ant-wrongidea-1234" }),
    }),
  )

  expect(response.status).toBe(400)

  // Refused, and the grant is left exactly as it was — a half-applied update
  // here would leave a connection nobody can authenticate with.
  const after = (await db.one<Sealed>(from(aiCredentials))) as Sealed
  expect(await open(after)).toBe("oat-notarealtoken-abcd")

  await db.close()
})

test("starting an OAuth flow needs a registered client, and an admin", async () => {
  const { db, handle, token } = await setup()

  const author = await createUser(db, {
    email: "author@example.com",
    name: "Author",
    password: "a secure password",
    role: "author",
  })
  const authorSession = await issueSession(db, author, { ip: "127.0.0.1", userAgent: "tests" })

  const forbidden = await handle(
    new Request("http://localhost/ai/oauth/anthropic/start", {
      method: "POST",
      headers: { authorization: `Bearer ${authorSession.token}` },
    }),
  )
  expect(forbidden.status).toBe(403)

  // Nothing is registered in the test environment, so an admin gets a 409 that
  // says what to do rather than a redirect into a broken consent screen.
  const unconfigured = await handle(
    new Request("http://localhost/ai/oauth/anthropic/start", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
  )
  expect(unconfigured.status).toBe(409)
  expect(await unconfigured.text()).toContain("AI_OAUTH_ANTHROPIC_CLIENT_ID")

  const unknown = await handle(
    new Request("http://localhost/ai/oauth/nowhere/start", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
  )
  expect(unknown.status).toBe(400)

  await db.close()
})

test("a callback carrying a forged state stores nothing", async () => {
  const { db, publicHandle } = await setup()

  const response = await publicHandle(
    new Request("http://localhost/ai/oauth/callback?code=whatever&state=not-a-real-state"),
  )

  // It redirects rather than 500s — the person reading it is in a browser tab
  // they were sent to, and needs a way back.
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toContain("connected=error")

  const stored = await db.all(from(aiCredentials))
  expect(stored).toHaveLength(0)

  await db.close()
})

test("a provider that declines is reported, not treated as a connection", async () => {
  const { db, publicHandle } = await setup()

  const response = await publicHandle(
    new Request("http://localhost/ai/oauth/callback?error=access_denied&error_description=User%20said%20no"),
  )

  expect(response.status).toBe(302)
  expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain("User said no")
  expect(await db.all(from(aiCredentials))).toHaveLength(0)

  await db.close()
})
