import type { Connection } from "atlas/db"
import type { Route } from "atlas/server"
import { get, json, post, putHeader, text } from "atlas/server"
import { findAgentKey, looksLikeAgentKey } from "../agents/verify.ts"
import { config } from "../config/index.ts"
import { sha256 } from "../ids/index.ts"
import { now } from "../time/index.ts"
import { oauthRoutes, resource } from "./oauth.ts"

type Rpc = {
  jsonrpc: "2.0"
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

const WRITES = new Set([
  "create_entry",
  "update_entry",
  "publish_entry",
  "unpublish_entry",
  "set_entry_status",
  "duplicate_entry",
  "delete_entry",
  "bulk_entries",
  "update_menu",
  "create_menu",
  "update_settings",
  "update_design",
])
const VERSION_META = "io.modelcontextprotocol/protocolVersion"
const SCRIPT = new URL("../../scripts/mcp.ts", import.meta.url).pathname
const challenge = `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", resource)}", error="invalid_token", error_description="Connect your Inkling account to continue"`

const linked = async (db: Connection, bearer: string): Promise<boolean> => {
  if (!looksLikeAgentKey(bearer)) return false
  const row = await findAgentKey(db, await sha256(bearer))
  return row !== null && row.audience === resource && row.revoked_at === null && row.expires_at > now()
}

const bridge = async (request: Rpc, key = ""): Promise<Record<string, unknown> | null> => {
  const modern = typeof (request.params?._meta as Record<string, unknown> | undefined)?.[VERSION_META] === "string"
  const setup =
    !modern && request.method !== "initialize"
      ? `${JSON.stringify({ jsonrpc: "2.0", id: "setup", method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`
      : ""
  const child = Bun.spawn({
    cmd: [Bun.which("bun") ?? "bun", "run", SCRIPT],
    env: {
      PATH: Bun.env.PATH ?? "",
      INKLING_URL: config.publicUrl,
      INKLING_KEY: key,
      INKLING_MCP_DESCRIBE: key ? "0" : "1",
      INKLING_MCP_REMOTE: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 65_000)
  try {
    child.stdin.write(`${setup}${JSON.stringify(request)}\n`)
    child.stdin.end()
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exit !== 0) throw new Error(stderr.slice(0, 300))
    const lines = stdout.trim().split("\n").filter(Boolean)
    return lines.map(line => JSON.parse(line) as Record<string, unknown>).find(line => line.id === request.id) ?? null
  } finally {
    clearTimeout(timer)
  }
}

const secured = (rpc: Record<string, unknown>): Record<string, unknown> => {
  const result = rpc.result as Record<string, unknown> | undefined
  if (!result || !Array.isArray(result.tools)) return rpc
  return {
    ...rpc,
    result: {
      ...result,
      tools: result.tools.map(raw => {
        const tool = raw as Record<string, unknown>
        const write = WRITES.has(String(tool.name))
        return {
          ...tool,
          securitySchemes: [{ type: "oauth2", scopes: ["site"] }],
          annotations: { readOnlyHint: !write, destructiveHint: write, openWorldHint: false },
        }
      }),
    },
  }
}

const denied = (id: string | number): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  result: {
    content: [{ type: "text", text: "Connect your Inkling account to continue." }],
    isError: true,
    _meta: { "mcp/www_authenticate": [challenge] },
  },
})

export const mcpRoutes = (db: Connection): Route[] => [
  ...oauthRoutes(db),
  get("/mcp", c => putHeader(text(c, 405, "Use POST for MCP requests"), "allow", "POST")),
  post("/mcp", async c => {
    const raw = await c.request.text()
    if (raw.length > 1_000_000) return json(c, 413, { error: "Request too large" })
    let rpc: Rpc
    try {
      rpc = JSON.parse(raw) as Rpc
    } catch {
      return json(c, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    }
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return json(c, 400, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32600, message: "Invalid request" } })
    }
    if (rpc.id === undefined) return text(c, 202, "")

    const header = c.request.headers.get("authorization") ?? ""
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
    const authorized = bearer !== "" && (await linked(db, bearer))
    if (rpc.method === "tools/call" && !authorized) return json(c, 200, denied(rpc.id))

    const version = c.request.headers.get("mcp-protocol-version")
    const request: Rpc =
      rpc.method === "initialize" || !version
        ? rpc
        : {
            ...rpc,
            params: {
              ...rpc.params,
              _meta: {
                ...(rpc.params?._meta as Record<string, unknown> | undefined),
                [VERSION_META]: version,
              },
            },
          }
    try {
      const response = await bridge(request, authorized ? bearer : "")
      if (!response) return text(c, 202, "")
      return json(c, 200, secured(response))
    } catch (error) {
      console.error(`[mcp] ${error instanceof Error ? error.message : error}`)
      return json(c, 500, { jsonrpc: "2.0", id: rpc.id, error: { code: -32603, message: "MCP request failed" } })
    }
  }),
]
