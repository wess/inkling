import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { agentKeyRoutes } from "../src/agents/index.ts"
import { contentTypeRoutes } from "../src/contenttypes/index.ts"
import { entryRoutes } from "../src/entries/index.ts"
import { prefixed } from "../src/http/index.ts"
import { id, secretToken, sha256 } from "../src/ids/index.ts"
import { mcpRoutes } from "../src/mcp/index.ts"
import { resource } from "../src/mcp/oauth.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { agentKeys, contentTypes } from "../src/schema/index.ts"
import { createUser } from "../src/users/index.ts"

test("remote editing creates a draft, preserves unrelated fields, publishes, and records revisions", async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const user = await createUser(db, {
    email: "campaign@example.test",
    name: "Campaign editor",
    password: "a test account password",
    role: "editor",
  })
  const key = secretToken("inkagt")
  const timestamp = new Date().toISOString()
  await db.execute(
    from(agentKeys).insert({
      id: id(),
      user_id: user.id,
      name: "Test desktop",
      hashed_key: await sha256(key),
      prefix: key.slice(0, 12),
      grants: JSON.stringify(["content.read", "content.write", "content.publish"]),
      created_at: timestamp,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
      last_used_at: null,
      last_ip: null,
      audience: resource,
    }),
  )
  await db.execute(
    from(contentTypes).insert({
      id: id(),
      name: "article",
      label: "Article",
      plural_label: "Articles",
      kind: "collection",
      fields: JSON.stringify([
        { key: "summary", type: "text", label: "Summary" },
        { key: "body", type: "text", label: "Body" },
      ]),
      sort_order: 0,
      owner_plugin: null,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  )
  const hooks = createHooks(() => {})
  const handle = router(
    ...mcpRoutes(db),
    ...prefixed("/api", [...agentKeyRoutes(db), ...contentTypeRoutes(db), ...entryRoutes(db, hooks)]),
  )
  const address = new URL(resource)
  const server = Bun.serve({
    hostname: address.hostname,
    port: Number(address.port) || 80,
    fetch: request => handle(request),
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(resource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } }),
    })
    const rpc = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } }
    expect(rpc.result.isError).toBe(false)
    return JSON.parse(rpc.result.content[0]?.text ?? "") as Record<string, any>
  }
  try {
    const created = await call("create_entry", {
      type: "article",
      title: "Release campaign",
      data: { summary: "First summary", body: "Keep this body" },
    })
    const entryId = created.id
    expect(created.status).toBe("draft")
    await call("update_entry", { id: entryId, data: { summary: "Updated summary" }, note: "Prepare campaign" })
    const edited = await call("get_entry", { id: entryId })
    expect(edited.data).toMatchObject({ summary: "Updated summary", body: "Keep this body" })
    expect(edited.status).toBe("draft")
    await call("publish_entry", { id: entryId })
    expect((await call("get_entry", { id: entryId })).status).toBe("published")
    const history = await call("list_revisions", { id: entryId })
    expect(history.data.length).toBeGreaterThan(0)
  } finally {
    server.stop(true)
    await db.close()
  }
})
