import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { aiRoutes, resolveCredential } from "../src/ai/index.ts"
import { PROVIDERS } from "../src/ai/providers.ts"
import { open, seal } from "../src/ai/secrets.ts"
import { issueSession } from "../src/auth/index.ts"
import { up } from "../src/migrate/index.ts"
import { aiCredentials } from "../src/schema/index.ts"
import { createUser } from "../src/users/index.ts"

// The whole point of this module is that an operator's provider key goes in and
// never comes back out, so that is what most of these assert.

test("a provider key round-trips through the seal and never survives tampering", async () => {
  const sealed = await seal("sk-ant-notarealkey-abcd")

  // The plaintext is not recoverable from what is stored.
  expect(sealed.ciphertext).not.toContain("notarealkey")
  expect(await open(sealed)).toBe("sk-ant-notarealkey-abcd")

  // The hint identifies the key without describing it.
  expect(sealed.hint).toBe("••••abcd")

  // AES-GCM authenticates, so a flipped byte fails to open rather than
  // returning garbage. Returning null is what surfaces as "reconnect this
  // provider" instead of a 500.
  const flipped = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -4)}AAAA` }
  expect(await open(flipped)).toBeNull()
  expect(await open({ ciphertext: "not base64 at all", iv: sealed.iv })).toBeNull()
})

test("two seals of the same key differ, so the ciphertext is not a fingerprint", async () => {
  const first = await seal("sk-ant-same-key-value")
  const second = await seal("sk-ant-same-key-value")

  expect(first.ciphertext).not.toBe(second.ciphertext)
  expect(first.iv).not.toBe(second.iv)
  expect(await open(first)).toBe(await open(second))
})

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

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
  const authorSession = await issueSession(db, author, { ip: "127.0.0.1", userAgent: "tests" })

  const handle = router(...aiRoutes(db))
  const call = (path: string, token: string, init: RequestInit = {}) =>
    handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }),
    )

  return { db, call, admin: adminSession.token, author: authorSession.token }
}

test("a base URL pasted from a provider's own docs does not double its /v1", async () => {
  // Reported from the field: entering https://ollama.com/v1 produced a request
  // for /v1/v1/chat/completions, because the client appends the /v1 itself. The
  // trailing one is dropped on the way in so the documented value works.
  const { call, admin } = await setup()

  const created = await call("/ai/credentials", admin, {
    method: "POST",
    body: JSON.stringify({ provider: "openai", key: "sk-notarealkey-wxyz", baseUrl: "https://gateway.example.com/v1" }),
  })
  expect(created.status).toBe(201)
  expect(((await created.json()) as { baseUrl: string }).baseUrl).toBe("https://gateway.example.com")

  // A gateway mounted under some other path is left exactly as typed — only the
  // specific double-prefix case is corrected.
  const nested = await call("/ai/credentials", admin, {
    method: "POST",
    body: JSON.stringify({
      provider: "openai",
      key: "sk-notarealkey-wxyz",
      baseUrl: "https://gateway.example.com/openai",
    }),
  })
  expect(((await nested.json()) as { baseUrl: string }).baseUrl).toBe("https://gateway.example.com/openai")
})

test("connecting a provider stores the key sealed and never returns it", async () => {
  const { db, call, admin } = await setup()

  const created = await call("/ai/credentials", admin, {
    method: "POST",
    body: JSON.stringify({ provider: "anthropic", key: "sk-ant-notarealkey-wxyz", label: "Main" }),
  })
  expect(created.status).toBe(201)

  const body = (await created.json()) as Record<string, unknown>
  expect(body.provider).toBe("anthropic")
  // Asserted against the catalog rather than a literal: the point is that
  // omitting the model falls back to the provider's default, not which model
  // that happens to be this month.
  expect(body.model).toBe(PROVIDERS.anthropic.defaultModel)
  expect(body.hint).toBe("••••wxyz")
  expect(body.isDefault).toBe(true)
  // The response shape is built field by field precisely so these cannot appear.
  expect(body.ciphertext).toBeUndefined()
  expect(body.iv).toBeUndefined()
  expect(body.key).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain("notarealkey")

  const listed = (await (await call("/ai/credentials", admin)).json()) as { data: Record<string, unknown>[] }
  expect(listed.data).toHaveLength(1)
  expect(JSON.stringify(listed.data)).not.toContain("notarealkey")

  // Internally it still opens, which is what the assistant relies on.
  const resolved = await resolveCredential(db)
  expect(resolved?.secret).toBe("sk-ant-notarealkey-wxyz")
  expect(resolved?.provider).toBe("anthropic")

  await db.close()
})

test("only an admin may connect a provider", async () => {
  const { db, call, author } = await setup()

  expect((await call("/ai/credentials", author)).status).toBe(403)
  expect(
    (
      await call("/ai/credentials", author, {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", key: "sk-ant-nope-1234" }),
      })
    ).status,
  ).toBe(403)

  await db.close()
})

test("provider input is validated before anything is stored", async () => {
  const { db, call, admin } = await setup()

  const unknown = await call("/ai/credentials", admin, {
    method: "POST",
    body: JSON.stringify({ provider: "definitely-not-a-provider", key: "sk-whatever" }),
  })
  expect(unknown.status).toBe(400)

  // Anthropic needs a key; a stub isn't one.
  expect(
    (
      await call("/ai/credentials", admin, {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", key: "short" }),
      })
    ).status,
  ).toBe(400)

  // Ollama needs a base URL instead of a key, and it has to be a real URL.
  expect(
    (
      await call("/ai/credentials", admin, {
        method: "POST",
        body: JSON.stringify({ provider: "ollama", baseUrl: "not a url" }),
      })
    ).status,
  ).toBe(400)

  const ollama = await call("/ai/credentials", admin, {
    method: "POST",
    body: JSON.stringify({ provider: "ollama", baseUrl: "http://127.0.0.1:11434" }),
  })
  expect(ollama.status).toBe(201)

  await db.close()
})

test("exactly one connection is the default, and removing it promotes another", async () => {
  const { db, call, admin } = await setup()

  const first = (await (
    await call("/ai/credentials", admin, {
      method: "POST",
      body: JSON.stringify({ provider: "anthropic", key: "sk-ant-first-0001" }),
    })
  ).json()) as { id: string }

  const second = (await (
    await call("/ai/credentials", admin, {
      method: "POST",
      body: JSON.stringify({ provider: "openai", key: "sk-openai-second-0002" }),
    })
  ).json()) as { id: string }

  // Adding a provider is expressing a preference, so the newest wins.
  const defaults = await db.all<{ id: string; is_default: number }>(from(aiCredentials).select("id", "is_default"))
  expect(defaults.filter(row => row.is_default === 1).map(row => row.id)).toEqual([second.id])

  expect((await resolveCredential(db))?.provider).toBe("openai")

  // Removing the default leaves the assistant working rather than off.
  expect((await call(`/ai/credentials/${second.id}`, admin, { method: "DELETE" })).status).toBe(200)
  expect((await resolveCredential(db))?.provider).toBe("anthropic")
  expect((await resolveCredential(db))?.id).toBe(first.id)

  await db.close()
})

test("with nothing connected the assistant reads as off rather than broken", async () => {
  const { db } = await setup()
  expect(await resolveCredential(db)).toBeNull()
  await db.close()
})
