import { afterEach, expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import { agentRoutes } from "../src/ai/agent.ts"
import { seal } from "../src/ai/secrets.ts"
import { issueSession } from "../src/auth/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { aiCredentials, contentTypes, entries } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"
import { noPlugins } from "./fixtures/registry.ts"

// Prompt caching is worth roughly ninety percent of the input cost of an agent
// turn, and it fails silently: the answers stay correct and only the invoice
// changes. tests/aiagent.test.ts pins the breakpoint bookkeeping; this pins the
// part bookkeeping cannot reach — that the markers actually leave the process,
// on the wire, in the shape the API reads.
//
// The Anthropic SDK honours ANTHROPIC_BASE_URL, so a server that speaks its SSE
// dialect stands in for the model and records what it was sent.

const previousBaseUrl = process.env.ANTHROPIC_BASE_URL

afterEach(() => {
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl
})

// Two shapes of turn. The mock answers with a tool call until the request
// carries a tool result, then with text — so one ask() drives two model calls
// and leaves a tool_use assistant turn and a tool_result user turn in the
// transcript. Those array-content messages are the only thing a rolling
// breakpoint can attach to, which is exactly what has to be exercised.
const textTurn = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looks good." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

const toolTurn = [
  { ...textTurn[0] },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name: "list_menus", input: {} },
  },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

// Only the newest message counts. Checking the whole transcript would see the
// previous turn's tool result and answer with text immediately, so every turn
// after the first would be a single call and never grow the transcript with the
// array-content messages a rolling breakpoint attaches to.
const carriesToolResult = (body: any): boolean => {
  const last = (body.messages ?? []).at(-1)
  return Array.isArray(last?.content) && last.content.some((b: any) => b?.type === "tool_result")
}

const mockAnthropic = () => {
  const seen: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json()
      seen.push(body)
      const script = carriesToolResult(body) ? textTurn : toolTurn
      const sse = script.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
      return new Response(sse, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, seen, baseUrl: `http://localhost:${server.port}` }
}

const setup = async () => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")

  const typeId = id()
  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "page",
      label: "Page",
      plural_label: "Pages",
      description: null,
      kind: "collection",
      preview_url: null,
      fields: JSON.stringify([{ key: "excerpt", type: "text", label: "Excerpt" }]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )

  await db.execute(
    from(entries).insert({
      id: id(),
      content_type_id: typeId,
      slug: "about",
      title: "About us",
      data: JSON.stringify({ excerpt: "We make things." }),
      status: "published",
      locale: "en",
      author_id: null,
      sort_order: 0,
      published_at: now(),
      scheduled_at: null,
      created_at: now(),
      updated_at: now(),
      deleted_at: null,
    }),
  )

  const sealed = await seal("sk-ant-test-key-value")
  await db.execute(
    from(aiCredentials).insert({
      id: id(),
      provider: "anthropic",
      label: "Claude",
      model: "claude-sonnet-5",
      base_url: null,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      hint: sealed.hint,
      is_default: 1,
      created_by: null,
      created_at: now(),
      updated_at: now(),
      last_used_at: null,
      revoked_at: null,
      auth_kind: "key",
      refresh_ciphertext: null,
      refresh_iv: null,
      expires_at: null,
      scope: null,
      account: null,
    }),
  )

  const editor = await createUser(db, {
    email: "editor@example.com",
    name: "Editor",
    password: "a secure password",
    role: "admin",
  })
  const session = await issueSession(db, editor, { ip: "127.0.0.1", userAgent: "tests" })

  return { db, token: session.token }
}

// The route answers with a stream, and the agent loop only advances as that
// stream is read — so the body has to be drained before the model has been
// called at all. Asserting on what the mock received without reading it first
// inspects an empty list and looks like a routing failure.
const ask = async (
  db: Awaited<ReturnType<typeof setup>>["db"],
  token: string,
  message: string,
  history?: unknown,
): Promise<{ status: number; history: unknown[] }> => {
  const response = await router(...agentRoutes(db, noPlugins))(
    new Request("http://localhost/ai/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(history === undefined ? { message } : { message, history }),
    }),
  )

  const text = await response.text()
  for (const block of text.split("\n\n")) {
    if (!/^event: done$/m.test(block)) continue
    const data = block.match(/^data: (.+)$/m)?.[1]
    if (data) return { status: response.status, history: JSON.parse(data).history as unknown[] }
  }
  throw new Error(`no done frame — the run failed: ${text.slice(0, 300)}`)
}

const markers = (blocks: unknown): number =>
  Array.isArray(blocks) ? blocks.filter(b => b && typeof b === "object" && "cache_control" in b).length : 0

test("the stable prefix goes out marked for caching", async () => {
  const mock = mockAnthropic()
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl
  const { db, token } = await setup()

  const { status } = await ask(db, token, "Shorten the about page excerpt")
  expect(status).toBe(200)

  const sent = mock.seen[0]

  // The system prompt goes as a block carrying the marker, not a bare string —
  // tools render ahead of it, so this one breakpoint caches the whole prefix.
  expect(Array.isArray(sent.system)).toBe(true)
  expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" })
  expect(String(sent.system[0].text)).toContain("You are Inky")

  // And the prefix is worth caching: the tool definitions ride ahead of it, and
  // they are the bulk of what would otherwise be re-bought on every step.
  expect(sent.tools.length).toBeGreaterThanOrEqual(9)

  mock.server.stop()
  await db.close()
})

test("markers never accumulate across turns", async () => {
  // The transcript round-trips through the browser. If a turn's markers came
  // back and were left in place, a long conversation would eventually exceed
  // the four the API allows — and only then start failing.
  const mock = mockAnthropic()
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl
  const { db, token } = await setup()

  let history = (await ask(db, token, "First")).history

  for (let turn = 0; turn < 6; turn += 1) {
    history = (await ask(db, token, `Turn ${turn}`, history)).history

    const request = mock.seen[mock.seen.length - 1]
    const inMessages = (request.messages as { content: unknown }[]).reduce(
      (total, message) => total + markers(message.content),
      0,
    )
    // One on the system block, at most two riding the transcript.
    expect(markers(request.system)).toBe(1)
    expect(inMessages).toBeLessThanOrEqual(2)
    expect(markers(request.system) + inMessages).toBeLessThanOrEqual(4)
  }

  mock.server.stop()
  await db.close()
})
