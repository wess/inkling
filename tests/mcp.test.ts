import { expect, test } from "bun:test"
import { resolve } from "node:path"

type Rpc = {
  id?: number | string | null
  result?: Record<string, any>
  error?: { code: number; message: string; data?: Record<string, any> }
}

const ROOT = resolve(import.meta.dir, "..")
const VERSION_META = "io.modelcontextprotocol/protocolVersion"

const meta = (version: string) => ({
  [VERSION_META]: version,
  "io.modelcontextprotocol/clientInfo": { name: "inkling-tests", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
})

const run = async (url: string, messages: unknown[]): Promise<{ messages: Rpc[]; stderr: string }> => {
  const process = Bun.spawn({
    cmd: [Bun.which("bun") ?? "bun", "run", "scripts/mcp.ts"],
    cwd: ROOT,
    env: { ...Bun.env, INKLING_URL: url, INKLING_KEY: "inkagt_test" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  process.stdin.write(`${messages.map(message => JSON.stringify(message)).join("\n")}\n`)
  process.stdin.end()

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  expect(exitCode).toBe(0)
  return {
    messages: stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Rpc),
    stderr,
  }
}

test("the MCP server supports current discovery and legacy initialization", async () => {
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/api/types") {
        await Bun.sleep(25)
        return Response.json({ data: [] })
      }
      if (path !== "/api/agents/me") return new Response("Not found", { status: 404 })
      return Response.json({
        data: {
          kind: "agent",
          name: "Test operator",
          email: "operator@example.com",
          role: "editor",
          grants: ["content.read"],
        },
      })
    },
  })

  try {
    const url = `http://${site.hostname}:${site.port}`
    const modern = await run(url, [
      {
        jsonrpc: "2.0",
        id: "discover",
        method: "server/discover",
        params: { _meta: meta("2026-07-28") },
      },
      {
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
        params: { _meta: meta("2026-07-28") },
      },
      {
        jsonrpc: "2.0",
        id: "unsupported",
        method: "tools/list",
        params: { _meta: meta("2099-01-01") },
      },
      {
        jsonrpc: "2.0",
        id: "cancelled",
        method: "tools/call",
        params: { _meta: meta("2026-07-28"), name: "list_types", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { _meta: meta("2026-07-28"), requestId: "cancelled", reason: "test" },
      },
    ])

    const discover = modern.messages.find(message => message.id === "discover")?.result
    expect(discover).toMatchObject({
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
      capabilities: { tools: {} },
      cacheScope: "private",
    })

    const list = modern.messages.find(message => message.id === "list")?.result
    expect(list?.resultType).toBe("complete")
    expect(list?.cacheScope).toBe("private")
    expect(list?.tools.length).toBeGreaterThan(0)
    expect(list?.tools.every((tool: { name: string }) => typeof tool.name === "string")).toBe(true)

    const unsupported = modern.messages.find(message => message.id === "unsupported")?.error
    expect(unsupported).toMatchObject({
      code: -32022,
      data: { requested: "2099-01-01", supported: ["2026-07-28", "2025-11-25", "2025-06-18"] },
    })
    expect(modern.messages.some(message => message.id === "cancelled")).toBe(false)

    const legacy = await run(url, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ])

    expect(legacy.messages.find(message => message.id === 1)?.result?.protocolVersion).toBe("2025-11-25")
    expect(legacy.messages.find(message => message.id === 2)?.result?.resultType).toBeUndefined()
    expect(legacy.stderr).toContain("tools against")
  } finally {
    site.stop(true)
  }
})
