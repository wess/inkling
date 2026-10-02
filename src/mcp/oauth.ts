import { verify } from "atlas/auth"
import type { Connection } from "atlas/db"
import { from } from "atlas/db"
import type { Route } from "atlas/server"
import { get, json, parseJson, pipeline, post, putHeader, text } from "atlas/server"
import { AGENT_PREFIX } from "../agents/verify.ts"
import { auth, requireAuth, requireHuman } from "../auth/guard.ts"
import { can, GRANTABLE_SCOPES } from "../auth/roles.ts"
import { config } from "../config/index.ts"
import { body } from "../http/index.ts"
import { id, secretToken, sha256 } from "../ids/index.ts"
import { encode } from "../json/index.ts"
import { agentKeys, mcpOauthCodes, users } from "../schema/index.ts"
import { createAudit, createRateLimit } from "../security/index.ts"
import { now } from "../time/index.ts"

const CLIENT = "https://chatgpt.com/oauth/client.json"
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"
const SCOPE = "site"
const TOOL_SCOPES = new Set([
  "content.read",
  "content.write",
  "content.publish",
  "content.delete",
  "menus.manage",
  "settings.manage",
])
const CODE_TTL = 60_000
const TOKEN_TTL = 90 * 86_400_000
const origin = new URL(config.publicUrl).origin
export const resource = `${origin}/mcp`

type Code = {
  hashed_code: string
  user_id: string
  client_id: string
  redirect_uri: string
  challenge: string
  resource: string
  expires_at: string
}

const clientValid = async (): Promise<boolean> => {
  try {
    const response = await fetch(CLIENT, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return false
    const data = (await response.json()) as Record<string, unknown>
    return (
      data.client_id === CLIENT &&
      Array.isArray(data.redirect_uris) &&
      data.redirect_uris.includes(REDIRECT) &&
      Array.isArray(data.token_endpoint_auth_methods_supported) &&
      data.token_endpoint_auth_methods_supported.includes("none")
    )
  } catch {
    return false
  }
}

const paramsValid = (params: URLSearchParams): boolean =>
  params.get("response_type") === "code" &&
  params.get("client_id") === CLIENT &&
  params.get("redirect_uri") === REDIRECT &&
  params.get("code_challenge_method") === "S256" &&
  /^[A-Za-z0-9_-]{43,128}$/.test(params.get("code_challenge") ?? "") &&
  params.get("resource") === resource &&
  (params.get("scope") ?? SCOPE) === SCOPE &&
  (params.get("state")?.length ?? 0) <= 2048

const responseHeaders = <T extends { respHeaders: Headers }>(conn: T): T => {
  const headers = new Headers(conn.respHeaders)
  headers.set("cache-control", "no-store")
  return { ...conn, respHeaders: headers }
}

const connectPage = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Inkling</title>
<style>
  body { font: 16px system-ui; background: #f6f4ef; color: #211e18; margin: 0; }
  main { max-width: 440px; margin: 12vh auto; padding: 32px; background: white; border: 1px solid #ddd8ce; border-radius: 12px; }
  h1 { font-size: 28px; margin: 0 0 12px; }
  p { line-height: 1.5; }
  label { display: block; margin: 18px 0 6px; font-weight: 600; }
  input { box-sizing: border-box; width: 100%; padding: 11px; font: inherit; border: 1px solid #b8b1a5; border-radius: 6px; }
  button { margin-top: 24px; width: 100%; padding: 12px; color: white; background: #211e18; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
  #error { color: #9b2222; }
</style>
<main>
  <h1>Connect Inkling</h1>
  <p>Sign in to allow your ChatGPT account to read and change this Inkling site within your existing permissions. You can disconnect it by revoking its key in Inkling settings.</p>
  <form id="connect">
    <label for="email">Inkling email</label><input id="email" type="email" autocomplete="username" required>
    <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
    <button>Sign in and connect</button>
  </form>
  <p id="error" role="alert"></p>
</main>
<script src="/mcp/connect.js" defer></script>
</html>`

const connectScript = `const form = document.querySelector("#connect")
const error = document.querySelector("#error")
form.addEventListener("submit", async event => {
  event.preventDefault()
  error.textContent = ""
  const button = form.querySelector("button")
  button.disabled = true
  try {
    const login = await fetch("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: document.querySelector("#email").value, password: document.querySelector("#password").value }),
    })
    const account = await login.json()
    if (!login.ok) throw new Error(account.error || "Sign in failed")
    const authorization = await fetch("/mcp/approve", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + account.token },
      body: JSON.stringify({ ...Object.fromEntries(new URLSearchParams(location.search)), password: document.querySelector("#password").value }),
    })
    document.querySelector("#password").value = ""
    const result = await authorization.json()
    if (!authorization.ok) throw new Error(result.error || "Connection failed")
    location.assign(result.redirect)
  } catch (cause) {
    error.textContent = cause.message || "Connection failed"
    button.disabled = false
  }
})`

const fail = (c: Parameters<typeof json>[0], status: number, error: string) =>
  json(responseHeaders(c), status, { error })

export const oauthRoutes = (db: Connection, validateClient = clientValid): Route[] => {
  const audit = createAudit(db)
  const limiter = createRateLimit(db)
  return [
    get("/.well-known/oauth-protected-resource", c =>
      json(responseHeaders(c), 200, {
        resource,
        authorization_servers: [origin],
        scopes_supported: [SCOPE],
      }),
    ),
    get("/.well-known/oauth-authorization-server", c =>
      json(responseHeaders(c), 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/mcp/authorize`,
        token_endpoint: `${origin}/mcp/token`,
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ["none"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [SCOPE],
      }),
    ),
    get("/mcp/authorize", async c => {
      const params = new URL(c.request.url).searchParams
      if (!paramsValid(params) || !(await validateClient())) return fail(c, 400, "Invalid connection request")
      return putHeader(
        putHeader(text(responseHeaders(c), 200, connectPage), "content-type", "text/html; charset=utf-8"),
        "content-security-policy",
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
    }),
    get("/mcp/connect.js", c =>
      putHeader(text(responseHeaders(c), 200, connectScript), "content-type", "application/javascript; charset=utf-8"),
    ),
    post(
      "/mcp/approve",
      pipeline(
        requireAuth(db),
        requireHuman,
        parseJson,
      )(async c => {
        const input = body(c)
        const params = new URLSearchParams(
          Object.entries(input).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
        )
        if (!paramsValid(params) || !(await validateClient())) return fail(c, 400, "Invalid connection request")
        const identity = auth(c)
        const verdict = await limiter.check(`mcp:approve:${identity.id}`, 8, 900)
        if (!verdict.ok) return fail(c, 429, "Too many attempts. Try again shortly.")
        const account = await db.one<{ password_hash: string }>(
          from(users)
            .select("password_hash")
            .where(q => q("id").equals(identity.id)),
        )
        if (!account || !(await verify(String(input.password ?? ""), account.password_hash).catch(() => false))) {
          return fail(c, 401, "Password is incorrect")
        }
        await limiter.clear(`mcp:approve:${identity.id}`)
        const placeholder = db.dialect === "postgres" ? "$1" : "?"
        await db.execute({ text: `DELETE FROM mcp_oauth_codes WHERE expires_at <= ${placeholder}`, values: [now()] })
        const code = secretToken("inkcode")
        await db.execute(
          from(mcpOauthCodes).insert({
            hashed_code: await sha256(code),
            user_id: identity.id,
            client_id: CLIENT,
            redirect_uri: REDIRECT,
            challenge: params.get("code_challenge") as string,
            resource,
            expires_at: new Date(Date.now() + CODE_TTL).toISOString(),
          }),
        )
        await audit.log({ userId: identity.id, event: "mcp.authorized" })
        const redirect = new URL(REDIRECT)
        redirect.searchParams.set("code", code)
        redirect.searchParams.set("iss", origin)
        if (params.has("state")) redirect.searchParams.set("state", params.get("state") as string)
        return json(responseHeaders(c), 200, { redirect: redirect.toString() })
      }),
    ),
    post("/mcp/token", async c => {
      const params = new URLSearchParams(await c.request.text())
      const code = params.get("code") ?? ""
      const verifier = params.get("code_verifier") ?? ""
      if (
        params.get("grant_type") !== "authorization_code" ||
        params.get("client_id") !== CLIENT ||
        params.get("redirect_uri") !== REDIRECT ||
        params.get("resource") !== resource ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(verifier) ||
        !code.startsWith("inkcode_")
      ) {
        return fail(c, 400, "invalid_request")
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
      const challenge = btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
      const hashed = await sha256(code)
      const token = await db.transaction(async tx => {
        const placeholder = tx.dialect === "postgres" ? "$1" : "?"
        const row = await tx.one<Code>({
          text: `DELETE FROM mcp_oauth_codes WHERE hashed_code = ${placeholder} RETURNING *`,
          values: [hashed],
        })
        if (
          !row ||
          row.expires_at <= now() ||
          row.client_id !== CLIENT ||
          row.redirect_uri !== REDIRECT ||
          row.resource !== resource ||
          row.challenge !== challenge
        )
          return null
        const user = await tx.one<{ id: string; role: string; deleted_at: string | null }>(
          from(users)
            .select("id", "role", "deleted_at")
            .where(q => q("id").equals(row.user_id)),
        )
        if (!user || user.deleted_at !== null) return null
        const access = secretToken(AGENT_PREFIX)
        const grants = GRANTABLE_SCOPES.filter(
          scope => TOOL_SCOPES.has(scope) && Object.values(can).some(cap => cap.scope === scope && cap(user.role)),
        )
        await tx.execute(
          from(agentKeys).insert({
            id: id(),
            name: "ChatGPT connection",
            hashed_key: await sha256(access),
            prefix: access.slice(0, AGENT_PREFIX.length + 9),
            grants: encode(grants),
            user_id: user.id,
            created_at: now(),
            last_used_at: null,
            last_ip: null,
            expires_at: new Date(Date.now() + TOKEN_TTL).toISOString(),
            revoked_at: null,
            audience: resource,
          }),
        )
        return access
      })
      if (!token) return fail(c, 400, "invalid_grant")
      return json(responseHeaders(c), 200, {
        access_token: token,
        token_type: "Bearer",
        expires_in: TOKEN_TTL / 1000,
        scope: SCOPE,
      })
    }),
  ]
}
