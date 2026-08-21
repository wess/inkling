import { expect, test } from "bun:test"
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

// The OpenAI-shaped loop carries two of the three providers — OpenAI itself, and
// Ollama, which serves a compatible endpoint locally and as Ollama Cloud. It is a
// wire format, so type-checking says nothing useful about it. What breaks is
// streamed tool-call deltas arriving in fragments, the tool result going back as
// its own message, and the transcript surviving a round trip.
//
// So this drives the real route against a real socket, with a server that speaks
// the dialect and nothing else standing in for the model.

type Turn = { toolCall?: { name: string; args: string }; text?: string }

// The chunk sequence a compatible endpoint actually sends. Tool arguments are
// deliberately split across two deltas, because reassembling them is the part
// most likely to be wrong and a single-chunk test would never catch it.
const chunksFor = (turn: Turn): string[] => {
  if (turn.toolCall) {
    const { name, args } = turn.toolCall
    const half = Math.ceil(args.length / 2)
    return [
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ]
  }
  return [
    JSON.stringify({ choices: [{ delta: { content: turn.text ?? "" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  ]
}

// `turns` is read at request time rather than captured, so a test can fill it in
// after setup has minted the ids the turns need to reference.
const mockProvider = (turns: Turn[]) => {
  const seen: { auth: string | null; body: any }[] = []
  let call = 0

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })

      seen.push({ auth: request.headers.get("authorization"), body: await request.json() })
      const turn = turns[Math.min(call, turns.length - 1)] ?? { text: "" }
      call += 1

      const body = `${chunksFor(turn)
        .map(chunk => `data: ${chunk}\n\n`)
        .join("")}data: [DONE]\n\n`

      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })

  return { server, seen, baseUrl: `http://localhost:${server.port}`, calls: () => call }
}

const setup = async (baseUrl: string, provider = "openai") => {
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

  const entryId = id()
  await db.execute(
    from(entries).insert({
      id: entryId,
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

  const sealed = await seal("sk-test-key-value")
  await db.execute(
    from(aiCredentials).insert({
      id: id(),
      provider,
      label: provider,
      model: "test-model",
      base_url: baseUrl,
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

  return { db, entryId, token: session.token }
}

const ask = async (db: Awaited<ReturnType<typeof setup>>["db"], token: string, message: string) => {
  const handle = router(...agentRoutes(db, noPlugins))
  const response = await handle(
    new Request("http://localhost/ai/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  )

  const text = await response.text()
  const out: { event: string; data: any }[] = []
  for (const block of text.split("\n\n")) {
    const event = block.match(/^event: (.+)$/m)?.[1]
    const data = block.match(/^data: (.+)$/m)?.[1]
    if (event && data) out.push({ event, data: JSON.parse(data) })
  }
  return { status: response.status, frames: out }
}

test("the OpenAI-shaped loop reads a tool, queues a proposal, and answers", async () => {
  const turns: Turn[] = []
  const mock = mockProvider(turns)
  const { db, entryId, token } = await setup(mock.baseUrl)

  turns.push(
    { toolCall: { name: "get_entry", args: JSON.stringify({ entryId }) } },
    {
      toolCall: {
        name: "propose_entry_update",
        args: JSON.stringify({ entryId, summary: "Tighten the excerpt", data: { excerpt: "We build things." } }),
      },
    },
    { text: "Queued a shorter excerpt for you to look at." },
  )

  const { status, frames } = await ask(db, token, "Make the about page excerpt shorter")
  expect(status).toBe(200)

  const kinds = frames.map(f => f.event)
  expect(kinds).toContain("tool")
  expect(kinds).toContain("proposal")
  expect(kinds).toContain("done")

  // Both tool calls were reassembled from split argument deltas and dispatched.
  const tools = frames.filter(f => f.event === "tool").map(f => f.data.name)
  expect(tools).toEqual(["get_entry", "propose_entry_update"])

  // The proposal reached the browser with its before-values, exactly as it does
  // on the Claude path.
  const proposal = frames.find(f => f.event === "proposal")?.data
  expect(proposal.kind).toBe("entry.update")
  expect(proposal.patch.data.excerpt).toBe("We build things.")
  expect(proposal.before.excerpt).toBe("We make things.")

  const answered = frames
    .filter(f => f.event === "text")
    .map(f => f.data.text)
    .join("")
  expect(answered).toContain("shorter excerpt")

  // Three round trips: read, propose, answer.
  expect(mock.calls()).toBe(3)

  // The row is untouched — a proposal is inert on this path too.
  const stored = await db.one<{ data: string }>(from(entries).where(q => q("id").equals(entryId)))
  expect(stored?.data).toContain("We make things.")

  mock.server.stop()
  await db.close()
})

test("the key rides Authorization, and the system prompt never enters the transcript", async () => {
  const turns: Turn[] = [{ text: "Nothing to change." }]
  const mock = mockProvider(turns)
  const { db, token } = await setup(mock.baseUrl)

  const { frames } = await ask(db, token, "Say hello")

  expect(mock.seen[0]?.auth).toBe("Bearer sk-test-key-value")

  // The prompt is sent, so the model has its instructions...
  const sent = mock.seen[0]?.body
  expect(sent.messages[0].role).toBe("system")
  expect(String(sent.messages[0].content)).toContain("You are Inky")
  expect(sent.tools.map((t: any) => t.function.name)).toContain("propose_menu_update")

  // ...but it is prepended per request, never stored. A transcript carrying a
  // system message would be a way to replace the instructions from the browser,
  // and the route refuses that role on the way back in.
  const history = frames.find(f => f.event === "done")?.data.history as { role: string }[]
  expect(history.some(message => message.role === "system")).toBe(false)
  expect(history[0]?.role).toBe("user")

  mock.server.stop()
  await db.close()
})

test("a returned transcript is accepted back, tool results and all", async () => {
  const turns: Turn[] = []
  const mock = mockProvider(turns)
  const { db, entryId, token } = await setup(mock.baseUrl)

  turns.push({ toolCall: { name: "get_entry", args: JSON.stringify({ entryId }) } }, { text: "Read it." })

  const first = await ask(db, token, "Read the about page")
  const history = first.frames.find(f => f.event === "done")?.data.history

  // The round trip is the point: OpenAI carries tool results as their own
  // messages, and the validator has to let that shape back in.
  expect((history as { role: string }[]).some(message => message.role === "tool")).toBe(true)

  const handle = router(...agentRoutes(db, noPlugins))
  const again = await handle(
    new Request("http://localhost/ai/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "And again", history }),
    }),
  )
  expect(again.status).toBe(200)

  mock.server.stop()
  await db.close()
})

test("Ollama is the same wire format pointed somewhere else", async () => {
  const turns: Turn[] = [{ text: "Local model answering." }]
  const mock = mockProvider(turns)
  // Stored exactly as an Ollama connection is: a base URL, and for a local
  // instance no key at all.
  const { db, token } = await setup(mock.baseUrl, "ollama")

  const { status, frames } = await ask(db, token, "Say hello")
  expect(status).toBe(200)

  // It reached the compatible endpoint, tools and all.
  expect(mock.seen[0]?.body.tools.length).toBeGreaterThan(0)

  const answered = frames
    .filter(f => f.event === "text")
    .map(f => f.data.text)
    .join("")
  expect(answered).toBe("Local model answering.")

  mock.server.stop()
  await db.close()
})
