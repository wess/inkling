import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { agentKeyRoutes } from "../src/agents/index.ts"
import { issueSession } from "../src/auth/index.ts"
import { contentTypeRoutes } from "../src/contenttypes/index.ts"
import { prefixed } from "../src/http/index.ts"
import { secretToken, sha256 } from "../src/ids/index.ts"
import { mcpRoutes } from "../src/mcp/index.ts"
import { oauthRoutes, resource } from "../src/mcp/oauth.ts"
import { up } from "../src/migrate/index.ts"
import { agentKeys, mcpOauthCodes } from "../src/schema/index.ts"
import { createUser } from "../src/users/index.ts"

const CLIENT = "https://chatgpt.com/oauth/client.json"
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"

test("remote MCP publishes OAuth metadata and prompts an unlinked account", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  try {
    const handle = router(...mcpRoutes(db))
    const metadata = await handle(new Request("http://localhost/.well-known/oauth-protected-resource"))
    expect(metadata.status).toBe(200)
    expect((await metadata.json()) as Record<string, unknown>).toMatchObject({ resource, scopes_supported: ["site"] })
    const pathMetadata = await handle(new Request("http://localhost/.well-known/oauth-protected-resource/mcp"))
    expect(pathMetadata.status).toBe(200)
    expect((await pathMetadata.json()) as Record<string, unknown>).toMatchObject({ resource })

    const list = await handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { result: { tools: { name: string; securitySchemes: unknown[] }[] } }
    expect(listed.result.tools.some(tool => tool.name === "update_entry")).toBe(true)
    expect(listed.result.tools.some(tool => tool.name === "upload_media")).toBe(false)
    expect(listed.result.tools.every(tool => tool.securitySchemes.length > 0)).toBe(true)

    const call = await handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_types" } }),
      }),
    )
    const denied = (await call.json()) as { result: { _meta: Record<string, unknown> } }
    expect(denied.result._meta["mcp/www_authenticate"]).toBeDefined()
  } finally {
    await db.close()
  }
})

test("account linking requires the account password and returns the registered callback", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  try {
    const password = "a securely long password"
    const user = await createUser(db, { email: "wife@example.com", name: "Editor", password, role: "editor" })
    const session = await issueSession(db, user, { ip: "127.0.0.1", userAgent: "tests" })
    const handle = router(...oauthRoutes(db, async () => true))
    const params = {
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
      code_challenge: "a".repeat(43),
      resource,
      state: "test-state",
      scope: "site",
    }
    const page = await handle(new Request(`http://localhost/mcp/authorize?${new URLSearchParams(params)}`))
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")

    const approve = (attempt: string) =>
      handle(
        new Request("http://localhost/mcp/approve", {
          method: "POST",
          headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
          body: JSON.stringify({ ...params, password: attempt }),
        }),
      )
    expect((await approve("wrong password")).status).toBe(401)
    const accepted = await approve(password)
    expect(accepted.status).toBe(200)
    const result = (await accepted.json()) as { redirect: string }
    const redirect = new URL(result.redirect)
    expect(redirect.origin).toBe("https://chatgpt.com")
    expect(redirect.searchParams.get("state")).toBe("test-state")
    expect(redirect.searchParams.get("iss")).toBe(new URL(resource).origin)
    expect(redirect.searchParams.get("code")).toStartWith("inkcode_")
  } finally {
    await db.close()
  }
})

test("account linking accepts a ChatGPT connection-specific callback", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  try {
    const callbackId = "a1b2c3d4-1234-5678-90ab-cdef12345678"
    const client = `https://chatgpt.com/oauth/${callbackId}/client.json`
    const redirect = `https://chatgpt.com/connector/oauth/${callbackId}`
    const handle = router(...oauthRoutes(db, async (id, uri) => id === client && uri === redirect))
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: redirect,
      code_challenge_method: "S256",
      code_challenge: "a".repeat(43),
      resource,
      scope: "site",
    })
    const response = await handle(new Request(`http://localhost/mcp/authorize?${params}`))
    expect(response.status).toBe(200)
  } finally {
    await db.close()
  }
})

test("account linking accepts Codex's temporary desktop callback", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  try {
    const client = "https://chatgpt.com/oauth/codex/client.json"
    const redirect = "http://127.0.0.1:63256/callback"
    const handle = router(...oauthRoutes(db, async (id, uri) => id === client && uri === redirect))
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: redirect,
      code_challenge_method: "S256",
      code_challenge: "a".repeat(43),
      resource,
      scope: "site",
    })
    const response = await handle(new Request(`http://localhost/mcp/authorize?${params}`))
    expect(response.status).toBe(200)
  } finally {
    await db.close()
  }
})

test("authorization code is single-use and issues a role-limited, audience-bound key", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  try {
    const user = await createUser(db, {
      email: "editor@example.com",
      name: "Editor",
      password: "a securely long password",
      role: "editor",
    })
    const verifier = "a".repeat(64)
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
    const challenge = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const code = secretToken("inkcode")
    await db.execute(
      from(mcpOauthCodes).insert({
        hashed_code: await sha256(code),
        user_id: user.id,
        client_id: CLIENT,
        redirect_uri: REDIRECT,
        challenge,
        resource,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    )
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
      resource,
    })
    const handle = router(...mcpRoutes(db))
    const exchange = () =>
      handle(
        new Request("http://localhost/mcp/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      )
    const first = await exchange()
    expect(first.status).toBe(200)
    const token = (await first.json()) as { access_token: string }
    expect(token.access_token).toStartWith("inkagt_")
    const hashed = await sha256(token.access_token)
    const row = await db.one<{ audience: string | null; grants: string }>(
      from(agentKeys)
        .select("audience", "grants")
        .where(q => q("hashed_key").equals(hashed)),
    )
    expect(row?.audience).toBe(resource)
    expect(JSON.parse(row?.grants ?? "[]")).toContain("content.publish")
    expect(JSON.parse(row?.grants ?? "[]")).not.toContain("settings.manage")
    expect((await exchange()).status).toBe(400)
  } finally {
    await db.close()
  }
})

test("a linked account can call a read tool through the remote bridge", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const user = await createUser(db, {
    email: "reader@example.com",
    name: "Reader",
    password: "a securely long password",
    role: "viewer",
  })
  const key = secretToken("inkagt")
  await db.execute(
    from(agentKeys).insert({
      id: crypto.randomUUID(),
      name: "ChatGPT connection",
      hashed_key: await sha256(key),
      prefix: key.slice(0, 15),
      grants: JSON.stringify(["content.read"]),
      user_id: user.id,
      created_at: new Date().toISOString(),
      last_used_at: null,
      last_ip: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
      audience: resource,
    }),
  )
  const address = new URL(resource)
  const handle = router(...mcpRoutes(db), ...prefixed("/api", [...agentKeyRoutes(db), ...contentTypeRoutes(db)]))
  const server = Bun.serve({
    hostname: address.hostname,
    port: Number(address.port) || 80,
    fetch: request => handle(request),
  })
  try {
    const response = await fetch(resource, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "read",
        method: "tools/call",
        params: {
          name: "list_types",
          arguments: {},
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    })
    expect(response.status).toBe(200)
    const rpc = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } }
    expect(rpc.result.isError).toBe(false)
    expect(JSON.parse(rpc.result.content[0]?.text ?? "") as Record<string, unknown>).toHaveProperty("data")
  } finally {
    server.stop(true)
    await db.close()
  }
})
