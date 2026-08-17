#!/usr/bin/env bun
//
// Inkling's admin API as MCP tools, so an agent can work a site from outside it.
//
//   INKLING_URL=https://apothecary.wess.dev \
//   INKLING_KEY=inkagt_… \
//   bun run scripts/mcp.ts
//
// This is not a second way to write content. Every tool below is a request to
// the same /api route the admin calls, so revisions, validation, slug
// uniqueness, relation checks, plugin hooks, and the audit trail all keep
// working, and history shows the account the key belongs to rather than a
// machine nobody can ask about it.
//
// It is deliberately not Inky (src/ai/agent.ts). Inky sits *inside* the admin
// and every change it makes is a proposal a human applies — right for an
// editor who is already looking at the screen, useless to an agent editing a
// site from a terminal somewhere else. The two are the same constraint solved
// for different rooms: Inky asks a person to press the button, this asks a
// person for a credential and then holds them to what that credential says.
//
// ─── WHERE THE BOUNDARY IS ──────────────────────────────────────────────────
//
// Not here. This process is a convenience, not a guard: it holds a secret, and
// anything that can read its environment can call whatever the secret allows,
// whatever tool list this file happens to publish. So the secret is an *agent
// key* (src/agents) — scoped to named capabilities, bounded by the role of the
// account that minted it, expiring, revocable on its own, and refused outright
// on every administrative route. An earlier version of this file took an email
// and a password and signed in. That is not a scoped credential; it is the
// account, and it could mint delivery keys, register webhooks, connect a social
// account, or create a second owner regardless of what was listed below.
//
// The tool list is filtered against the key's real grants, read from the server
// at startup. That is presentation: it stops the model planning around a call
// that would 403. The refusal itself happens in Inkling.
//
// One process per site. The key is per-site and a `site` argument on every tool
// would mean holding all of them at once, so the URL and the key come from the
// environment and the MCP client names the server after the site.
//
// stdio JSON-RPC, hand-rolled rather than pulled from the SDK: the framing is
// newline-delimited JSON and three methods, which is smaller than the dependency
// would be. STDOUT CARRIES PROTOCOL ONLY — anything diagnostic goes to stderr,
// or the client sees a parse error instead of a response.

import pkg from "../package.json"

const BASE = process.env.INKLING_URL ?? ""
const KEY = process.env.INKLING_KEY ?? ""
// Narrows further than the key does — for pointing an agent at production to
// look rather than touch without minting a second key. It is a convenience and
// nothing more: the key is what production actually enforces.
const READONLY = /^(1|true|yes)$/i.test(process.env.INKLING_MCP_READONLY ?? "")

if (!BASE || !KEY) {
  console.error(
    "Set INKLING_URL and INKLING_KEY.\n" +
      "INKLING_KEY is an agent key — mint one in the admin under Settings → Agent keys,\n" +
      "granting only what this agent needs. Passwords are no longer accepted here.",
  )
  process.exit(1)
}

if (!KEY.startsWith("inkagt_")) {
  console.error(
    "INKLING_KEY does not look like an agent key (they start with `inkagt_`).\n" +
      "A delivery key (`ink_…`) reads published content and cannot reach the admin API;\n" +
      "a password is not accepted at all. Mint an agent key in the admin.",
  )
  process.exit(1)
}

const log = (message: string): void => {
  console.error(`[inkling-mcp] ${message}`)
}

// ─── the admin API ──────────────────────────────────────────────────────────

// Everything that needs a credential lives under /api. A bare path is an *admin
// screen*, which answers 200 with a page of HTML rather than 404ing — so a
// wrong path fails by returning a document, not by erroring. Insisting on JSON
// is what turns that into a visible failure; see the same note in a site's
// seed, where a lenient parse once reported every step as a success and wrote
// nothing.
const API = "/api"

type CallInit = { method?: string; body?: unknown; query?: Record<string, unknown> }

const search = (query: Record<string, unknown> | undefined): string => {
  if (!query) return ""
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ""
}

// No retry on 401. A session used to be refreshable by signing in again; an
// agent key is not — a 401 means revoked, expired, or wrong, and all three want
// a person, not another attempt.
const call = async <T>(path: string, init: CallInit = {}): Promise<T> => {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST")
  const response = await fetch(new URL(`${API}${path}${search(init.query)}`, BASE), {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`)
  if (!text) return {} as T

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${method} ${path} → ${response.status} but not JSON: ${text.slice(0, 160)}`)
  }
}

// ─── tools ──────────────────────────────────────────────────────────────────

// The capability names in src/auth/roles.ts. Spelled out per tool so the filter
// below is the same vocabulary the server refuses in, rather than a second
// notion of "write" that could drift from it.
type Scope =
  | "content.read"
  | "content.write"
  | "content.publish"
  | "content.delete"
  | "media.manage"
  | "menus.manage"
  | "settings.manage"

type Tool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  // The grant Inkling will check. A tool whose grant the key does not hold is
  // hidden from tools/list and refused here.
  readonly needs: Scope
  readonly run: (args: Record<string, any>) => Promise<unknown>
}

const WRITES: ReadonlySet<Scope> = new Set([
  "content.write",
  "content.publish",
  "content.delete",
  "media.manage",
  "menus.manage",
  "settings.manage",
])

const object = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties: false,
})

const str = (description: string) => ({ type: "string", description })
const num = (description: string) => ({ type: "number", description })
const bag = (description: string) => ({ type: "object", description, additionalProperties: true })

// A URL an agent asked us to fetch is not a URL an operator typed. Loopback and
// the private ranges are refused because this process usually runs on somebody's
// laptop or a build box, where "fetch this and store it" reaches a metadata
// service or an internal admin panel that has no other way in.
const fetchable = (raw: string): URL => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not a URL: ${raw}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs can be fetched")

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host)
  if (blocked) throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)

  return url
}

const TOOLS: readonly Tool[] = [
  {
    name: "list_types",
    description:
      "List the site's content types with their fields. Start here: field names and types are what create_entry and " +
      "update_entry need for their `data`, and they differ per site.",
    inputSchema: object({}),
    needs: "content.read",
    run: () => call("/types"),
  },
  {
    name: "get_type",
    description:
      "One content type in full, with its field definitions and how many entries it holds. `kind` is 'single' for a " +
      "type that holds exactly one entry (a homepage, site hours) and 'collection' otherwise.",
    inputSchema: object({ name: str("The type's handle, e.g. 'post' — not its label") }, ["name"]),
    needs: "content.read",
    run: a => call(`/types/${encodeURIComponent(a.name)}`),
  },
  {
    name: "list_entries",
    description:
      "Entries of one content type, newest-updated first by default. Returns a `meta.total` alongside the page, so " +
      "check it before assuming one call saw everything — the page limit is 100.",
    inputSchema: object(
      {
        type: str("The content type's handle"),
        status: str("Filter: draft, review, published, archived, or 'all'. Defaults to all."),
        q: str("Match against the title"),
        limit: num("Page size, max 100 (default 20)"),
        offset: num("Rows to skip, for paging"),
        sort: str("updated_at, created_at, published_at, title, slug, or sort_order"),
        order: str("asc or desc (default desc)"),
      },
      ["type"],
    ),
    needs: "content.read",
    run: a =>
      call(`/types/${encodeURIComponent(a.type)}/entries`, {
        query: { status: a.status, q: a.q, limit: a.limit, offset: a.offset, sort: a.sort, order: a.order },
      }),
  },
  {
    name: "get_entry",
    description:
      "One entry by id, with its full `data`. Read this before updating, so you know what you are merging over.",
    inputSchema: object({ id: str("The entry id") }, ["id"]),
    needs: "content.read",
    run: a => call(`/entries/${encodeURIComponent(a.id)}`),
  },
  {
    name: "search",
    description:
      "Search entry titles and media filenames across the whole site. A quick way to find an id when you know roughly " +
      "what a thing is called. Needs at least two characters.",
    inputSchema: object({ q: str("Search term"), limit: num("Max results per kind, up to 50") }, ["q"]),
    needs: "content.read",
    run: a => call("/search", { query: { q: a.q, limit: a.limit } }),
  },
  {
    name: "list_revisions",
    description: "The revision history of one entry. Each edit snapshots the state it replaced.",
    inputSchema: object({ id: str("The entry id") }, ["id"]),
    needs: "content.read",
    run: a => call(`/entries/${encodeURIComponent(a.id)}/revisions`),
  },
  {
    name: "list_media",
    description: "The media library, newest first.",
    inputSchema: object({ limit: num("Page size, max 100"), offset: num("Rows to skip"), q: str("Match a filename") }),
    needs: "content.read",
    run: a => call("/media", { query: { limit: a.limit, offset: a.offset, q: a.q } }),
  },
  {
    name: "list_menus",
    description: "The site's navigation menus.",
    inputSchema: object({}),
    needs: "content.read",
    run: () => call("/menus"),
  },
  {
    name: "get_menu",
    description: "One menu and its items.",
    inputSchema: object({ name: str("The menu's handle, e.g. 'main'") }, ["name"]),
    needs: "content.read",
    run: a => call(`/menus/${encodeURIComponent(a.name)}`),
  },
  {
    name: "get_settings",
    description: "Site settings, along with the schema of which keys exist and what type each one takes.",
    inputSchema: object({}),
    needs: "content.read",
    run: () => call("/settings"),
  },
  {
    name: "list_taxonomies",
    description: "Taxonomies and their terms — categories, tags, whatever this site defines.",
    inputSchema: object({}),
    needs: "content.read",
    run: () => call("/taxonomies"),
  },

  // ─── writes ───────────────────────────────────────────────────────────────

  {
    name: "create_entry",
    description:
      "Create an entry. It is always a DRAFT — publish it separately once you have checked it. `data` is keyed by the " +
      "field names from get_type and is validated against them. The slug is derived from the title when omitted, and " +
      "made unique either way. A 'single' type refuses this once it has its one entry; update that one instead.",
    inputSchema: object(
      {
        type: str("The content type's handle"),
        title: str("The entry title"),
        data: bag("Field values, keyed by field name"),
        slug: str("URL slug. Derived from the title when omitted."),
        locale: str("Locale code, defaults to 'en'"),
        sortOrder: num("Manual ordering position"),
      },
      ["type", "title", "data"],
    ),
    needs: "content.write",
    run: a =>
      call(`/types/${encodeURIComponent(a.type)}/entries`, {
        method: "POST",
        body: { title: a.title, data: a.data ?? {}, slug: a.slug, locale: a.locale, sortOrder: a.sortOrder },
      }),
  },
  {
    name: "update_entry",
    description:
      "Update an entry. THIS MERGES: keys you leave out of `data` keep their stored value, so you can send one field " +
      "without resending the entry. To CLEAR a field you must pass it explicitly as null — omitting it does nothing. " +
      "Updating a published entry edits what is live. The pre-edit state is snapshotted as a revision first.",
    inputSchema: object(
      {
        id: str("The entry id"),
        data: bag("Field values to merge over what is stored"),
        title: str("New title"),
        slug: str("New slug. Changing this changes the entry's URL."),
        note: str("A short reason, recorded on the revision this edit replaces"),
        sortOrder: num("Manual ordering position"),
      },
      ["id"],
    ),
    needs: "content.write",
    run: a =>
      call(`/entries/${encodeURIComponent(a.id)}`, {
        method: "PUT",
        body: { data: a.data, title: a.title, slug: a.slug, note: a.note, sortOrder: a.sortOrder },
      }),
  },
  {
    name: "publish_entry",
    description:
      "Publish an entry, or schedule it by passing `at`. This puts it on the live site. Republishing something already " +
      "published is a no-op rather than an error.",
    inputSchema: object(
      { id: str("The entry id"), at: str("ISO 8601 time to publish at. Publishes immediately when omitted.") },
      ["id"],
    ),
    needs: "content.publish",
    run: a => call(`/entries/${encodeURIComponent(a.id)}/publish`, { method: "POST", query: { at: a.at } }),
  },
  {
    name: "unpublish_entry",
    description: "Take an entry off the live site, back to draft.",
    inputSchema: object({ id: str("The entry id") }, ["id"]),
    needs: "content.publish",
    run: a => call(`/entries/${encodeURIComponent(a.id)}/unpublish`, { method: "POST" }),
  },
  {
    name: "set_entry_status",
    description:
      "Move an entry between the editorial states: draft, review, or archived. Use publish_entry to go live — this " +
      "route deliberately will not.",
    inputSchema: object({ id: str("The entry id"), status: str("draft, review, or archived") }, ["id", "status"]),
    needs: "content.write",
    run: a => call(`/entries/${encodeURIComponent(a.id)}/status`, { method: "POST", body: { status: a.status } }),
  },
  {
    name: "duplicate_entry",
    description:
      "Copy an entry. The copy is always a draft with a '-copy' slug, never inheriting published state — the usual way " +
      "to start a variant of an existing page or product.",
    inputSchema: object({ id: str("The entry id to copy") }, ["id"]),
    needs: "content.write",
    run: a => call(`/entries/${encodeURIComponent(a.id)}/duplicate`, { method: "POST" }),
  },
  {
    name: "delete_entry",
    description:
      "Move an entry to trash. This is a soft delete — it is recoverable from the admin's trash — but it does remove " +
      "the entry from the live site immediately. Prefer unpublish_entry when you only want it off the site.",
    inputSchema: object({ id: str("The entry id") }, ["id"]),
    needs: "content.delete",
    run: a => call(`/entries/${encodeURIComponent(a.id)}`, { method: "DELETE" }),
  },
  {
    name: "bulk_entries",
    description:
      "Apply one action to up to 200 entries. Results are per-entry rather than all-or-nothing, so read the response: " +
      "a partial failure is the normal case and the successes are not rolled back. The publish and delete actions each " +
      "need their own grant on top of this one.",
    inputSchema: object(
      {
        ids: { type: "array", items: { type: "string" }, description: "Entry ids, max 200" },
        action: str("publish, unpublish, draft, review, archive, or delete"),
        at: str("ISO 8601 time, for a scheduled publish"),
      },
      ["ids", "action"],
    ),
    needs: "content.write",
    run: a => call("/entries/bulk", { method: "POST", body: { ids: a.ids, action: a.action, at: a.at } }),
  },
  {
    name: "upload_media",
    description:
      "Add a file to the media library, from a local path or by fetching a URL. Returns the stored record including " +
      "the `id` and `url` to reference from an entry's media field.",
    inputSchema: object(
      {
        path: str("Absolute path to a local file. Use this or `url`, not both."),
        url: str("A public http(s) URL to fetch and store. Use this or `path`, not both."),
        filename: str("Override the stored filename"),
        alt: str("Alt text. Worth setting — it is what screen readers read."),
      },
      [],
    ),
    needs: "media.manage",
    run: async a => {
      if (!a.path && !a.url) throw new Error("Pass either `path` or `url`")
      if (a.path && a.url) throw new Error("Pass `path` or `url`, not both")

      const source = a.path
        ? { blob: Bun.file(a.path) as Blob, name: a.path.split("/").pop() ?? "upload" }
        : await (async () => {
            const url = fetchable(a.url)
            const fetched = await fetch(url, { redirect: "error" })
            if (!fetched.ok) throw new Error(`Could not fetch ${a.url} → ${fetched.status}`)
            return { blob: await fetched.blob(), name: url.pathname.split("/").pop() || "upload" }
          })()

      const form = new FormData()
      form.set("file", source.blob, a.filename ?? source.name)
      if (a.alt) form.set("alt", a.alt)

      // Not through call(): multipart must set its own boundary, so the
      // content-type header is left to FormData rather than spelled here.
      const response = await fetch(new URL(`${API}/media`, BASE), {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        body: form,
      })

      const text = await response.text()
      if (!response.ok) throw new Error(`POST /media → ${response.status} ${text.slice(0, 300)}`)
      return JSON.parse(text)
    },
  },
  {
    name: "update_menu",
    description:
      "Replace a menu's label or its items. `items` is the whole list, not a patch — send every item you want to keep.",
    inputSchema: object(
      {
        name: str("The menu's handle"),
        label: str("New display label"),
        items: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "The full item list",
        },
      },
      ["name"],
    ),
    needs: "menus.manage",
    run: a => call(`/menus/${encodeURIComponent(a.name)}`, { method: "PUT", body: { label: a.label, items: a.items } }),
  },
  {
    name: "update_settings",
    description:
      "Change site settings. Only keys in the schema from get_settings are accepted — an unknown one is refused rather " +
      "than stored. Pass just the keys you are changing.",
    inputSchema: object({ values: bag("The settings to change, keyed by setting name") }, ["values"]),
    needs: "settings.manage",
    run: a => call("/settings", { method: "PUT", body: a.values }),
  },
]

// ─── what this key can actually do ──────────────────────────────────────────

type Whoami = { data: { kind: string; name: string; email: string; role: string; grants: string[] } }

// Asked once, at startup, and treated as the truth about what to publish. If the
// server is unreachable or the key is dead there is nothing useful to offer, so
// this fails loudly rather than starting up with a tool list that will 401 on
// every call — a client that lists twenty tools and then errors on all of them
// is worse than one that refuses to start.
const introspect = async (): Promise<Whoami["data"]> => {
  try {
    const me = await call<Whoami>("/agents/me")
    if (!me.data || !Array.isArray(me.data.grants)) throw new Error("unexpected response")
    return me.data
  } catch (error) {
    console.error(
      `[inkling-mcp] could not verify the key against ${BASE}: ${error instanceof Error ? error.message : error}\n` +
        "Check INKLING_URL, and that the key has not been revoked or expired.",
    )
    process.exit(1)
  }
}

const me = await introspect()
const held = new Set(me.grants)

const available = TOOLS.filter(tool => held.has(tool.needs) && !(READONLY && WRITES.has(tool.needs)))
const byName = new Map(available.map(tool => [tool.name, tool]))

// ─── JSON-RPC over stdio ────────────────────────────────────────────────────

type Request = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any }

// The client proposes a protocol version and we answer with one. Echoing what
// it asked for keeps this working as the spec moves, rather than pinning a
// version this file would have to be edited to bump.
const PROTOCOL = "2025-06-18"

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const reply = (id: number | string, result: unknown): void => {
  send({ jsonrpc: "2.0", id, result })
}

const handle = async (request: Request): Promise<void> => {
  // A notification has no id and takes no response — `notifications/initialized`
  // is the one that matters. Answering it is a protocol error.
  if (request.id === undefined) return

  switch (request.method) {
    case "initialize":
      reply(request.id, {
        protocolVersion:
          typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "inkling", version: pkg.version },
        instructions:
          `Content tools for the Inkling site at ${BASE}, acting as ${me.name || me.email}. ` +
          "Call list_types first — field names differ per site, and create_entry/update_entry are validated against " +
          "them. New entries are drafts until publish_entry is called. " +
          `This credential is limited to: ${[...held].join(", ")}. Anything not listed is refused by the site, not ` +
          "by this tool — do not plan around it.",
      })
      return

    case "tools/list":
      reply(request.id, {
        tools: available.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      })
      return

    case "tools/call": {
      const name = String(request.params?.name ?? "")
      const tool = byName.get(name)

      if (!tool) {
        const known = TOOLS.find(t => t.name === name)
        const why = !known
          ? `No tool named "${name}".`
          : READONLY && WRITES.has(known.needs)
            ? `"${name}" writes, and this server is running read-only.`
            : `"${name}" needs the "${known.needs}" grant, which this key does not hold.`
        reply(request.id, { content: [{ type: "text", text: why }], isError: true })
        return
      }

      // A failed tool call comes back as a result the model can read and work
      // around, not a JSON-RPC error — a 409 on a single-kind type or a
      // validation refusal is information, and the agent should see the text.
      try {
        const result = await tool.run((request.params?.arguments ?? {}) as Record<string, any>)
        reply(request.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] })
      } catch (error) {
        reply(request.id, {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        })
      }
      return
    }

    default:
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } })
  }
}

log(`${me.name || me.email} (${me.role}, ${me.kind}) · grants: ${[...held].join(", ") || "none"}`)
log(`${available.length} of ${TOOLS.length} tools against ${BASE}${READONLY ? " (read-only)" : ""}`)
if (available.length === 0) log("this key grants nothing these tools can use — check what it was minted with")

// Newline-delimited JSON, decoded incrementally: a message can arrive split
// across chunks, and two can arrive in one.
const decoder = new TextDecoder()
let buffer = ""

for await (const chunk of process.stdin) {
  buffer += decoder.decode(chunk as Uint8Array, { stream: true })

  let newline = buffer.indexOf("\n")
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\n")

    if (!line) continue
    try {
      await handle(JSON.parse(line) as Request)
    } catch (error) {
      log(`bad message: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
