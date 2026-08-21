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

// What the browser actually receives. The tool layer is pinned in
// aiagent/aitools; this pins the frames in between — that a proposal reaches the
// panel carrying the capability its Apply will need, that a navigation arrives
// as its own proposal, and that the tool list on the wire is the one the asking
// role could apply. Each of those is invisible from either side alone.
//
// The Anthropic SDK honours ANTHROPIC_BASE_URL, so a server speaking its SSE
// dialect stands in for the model and records what it was sent.

const previousBaseUrl = process.env.ANTHROPIC_BASE_URL

afterEach(() => {
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl
})

const start = {
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
}

const callTurn = (name: string, input: object) => [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

const textTurn = [
  start,
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Queued." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
  { type: "message_stop" },
]

// One tool call, then a sentence. The second request carries the tool result,
// which is how the mock knows the call already happened.
const mockAnthropic = (name: string, input: object) => {
  const seen: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages?: { content?: unknown }[] }
      seen.push(body as Record<string, unknown>)
      const last = (body.messages ?? []).at(-1)
      const answered =
        Array.isArray(last?.content) &&
        last.content.some((block: unknown) => (block as { type?: string })?.type === "tool_result")
      const script = answered ? textTurn : callTurn(name, input)
      return new Response(script.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return { server, seen, baseUrl: `http://localhost:${server.port}` }
}

const setup = async (role: string) => {
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

  const person = await createUser(db, {
    email: `${role}@example.com`,
    name: role,
    password: "a secure password",
    role,
  })
  const session = await issueSession(db, person, { ip: "127.0.0.1", userAgent: "tests" })

  return { db, entryId, token: session.token }
}

// Every frame, in order, the way the panel reads them.
const frames = async (db: Awaited<ReturnType<typeof setup>>["db"], token: string, message: string) => {
  const response = await router(...agentRoutes(db, noPlugins))(
    new Request("http://localhost/ai/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }),
  )

  const text = await response.text()
  return text
    .split("\n\n")
    .filter(block => block.trim() !== "")
    .map(block => ({
      event: block.match(/^event: (.+)$/m)?.[1] ?? "",
      data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? "null") as Record<string, unknown>,
    }))
}

test("a proposal reaches the browser carrying the capability its Apply will need", async () => {
  const { db, entryId, token } = await setup("admin")
  const mock = mockAnthropic("propose_entry_update", {
    entryId,
    summary: "Tighten the excerpt",
    data: { excerpt: "We build tools for editors." },
  })
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl

  const received = await frames(db, token, "Shorten the about page excerpt")
  const proposal = received.find(frame => frame.event === "proposal")?.data
  expect(proposal?.kind).toBe("entry.update")
  expect(proposal?.needs).toBe("content.write")

  // And the tool trace the panel prints alongside it.
  expect(received.find(frame => frame.event === "tool")?.data.name).toBe("propose_entry_update")
  expect(received.at(-1)?.event).toBe("done")

  // Still inert on the wire, as everywhere else.
  const stored = await db.one<{ data: string }>(from(entries).where(q => q("id").equals(entryId)))
  expect(stored?.data).toContain("We make things.")

  mock.server.stop()
  await db.close()
})

test("moving the admin arrives as its own frame", async () => {
  const { db, token } = await setup("admin")
  const mock = mockAnthropic("open_screen", {
    screen: "socialsettings",
    label: "Open Social settings",
    why: "the client secret is pasted here",
  })
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl

  const received = await frames(db, token, "Where do I put the Instagram secret?")
  const proposal = received.find(frame => frame.event === "proposal")?.data
  expect(proposal?.kind).toBe("admin.open")
  expect(proposal?.screen).toBe("socialsettings")
  expect(proposal?.label).toBe("Open Social settings")

  mock.server.stop()
  await db.close()
})

test("the tool list on the wire is the one the asking role could apply", async () => {
  const mock = mockAnthropic("list_menus", {})
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl

  const asAuthor = await setup("author")
  await frames(asAuthor.db, asAuthor.token, "What is in my menus?")
  const authorTools = (mock.seen[0]?.tools as { name: string }[]).map(tool => tool.name)
  expect(authorTools).toContain("propose_entry_update")
  expect(authorTools).not.toContain("propose_settings_update")
  expect(authorTools).not.toContain("get_social_setup")
  await asAuthor.db.close()

  // The first request of the second run, rather than counting back from the
  // end — a run makes one request per step, and that number is not this test's
  // business.
  const beforeOwner = mock.seen.length
  const asOwner = await setup("owner")
  await frames(asOwner.db, asOwner.token, "What is in my menus?")
  const ownerTools = (mock.seen[beforeOwner]?.tools as { name: string }[]).map(tool => tool.name)
  expect(ownerTools).toContain("propose_settings_update")
  expect(ownerTools).toContain("get_social_setup")
  expect(ownerTools.length).toBeGreaterThan(authorTools.length)
  await asOwner.db.close()

  mock.server.stop()
})
