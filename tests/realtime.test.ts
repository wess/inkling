import { expect, test } from "bun:test"
import type { Identity } from "../src/auth/guard.ts"
import type { KeyIdentity } from "../src/keys/index.ts"
import { createTicketStore } from "../src/realtime/tickets.ts"
import type { Audience } from "../src/realtime/topics.ts"
import { contentTopic, entryTopic, isTopic, maySubscribe, readInbound, shapeFor } from "../src/realtime/topics.ts"

// The socket is a second door onto the same content, so these tests are mostly
// about it granting no more than the HTTP surface does.

const editor: Audience = {
  kind: "session",
  identity: { id: "u1", email: "editor@example.com", name: "Ed", role: "editor", jti: "j1" } as Identity,
}

const openKey = (scopes: string[] = []): Audience => ({
  kind: "key",
  identity: { id: "k1", name: "site", scopes } as KeyIdentity,
})

test("topics are validated rather than taken at face value", () => {
  expect(isTopic("site")).toBe(true)
  expect(isTopic(contentTopic("article"))).toBe(true)
  expect(isTopic(entryTopic("3f2504e0-4f89-11d3-9a0c-0305e82c3301"))).toBe(true)

  // A content topic names a handle, not an arbitrary string.
  expect(isTopic("content:Not A Handle")).toBe(false)
  expect(isTopic("content:")).toBe(false)
  // An entry topic names a uuid, so this cannot be used to probe ids.
  expect(isTopic("entry:1")).toBe(false)
  expect(isTopic("wildcard:*")).toBe(false)
  expect(isTopic("")).toBe(false)
})

test("a delivery key cannot subscribe outside its scopes, and never to an entry", () => {
  const scoped = openKey(["article"])

  expect(maySubscribe(scoped, contentTopic("article"))).toBe(true)
  expect(maySubscribe(scoped, contentTopic("product"))).toBe(false)

  // An empty scope list means every type, matching keyAllows.
  expect(maySubscribe(openKey(), contentTopic("product"))).toBe(true)

  // Activity on one entry is editorial signal about work that may be a draft.
  expect(maySubscribe(scoped, entryTopic("3f2504e0-4f89-11d3-9a0c-0305e82c3301"))).toBe(false)
  expect(maySubscribe(editor, entryTopic("3f2504e0-4f89-11d3-9a0c-0305e82c3301"))).toBe(true)

  // Site-level invalidation is legitimately useful to a consuming site.
  expect(maySubscribe(scoped, "site")).toBe(true)
})

test("frames delivered to a key carry identity only, and drafts are never announced", () => {
  const envelope = {
    topic: contentTopic("article"),
    event: "entry.published",
    data: { id: "e1", slug: "hello", type: "article", title: "Hello", status: "published", secret: "leaked" },
  }

  const forEditor = shapeFor(editor, envelope)
  expect(forEditor?.data.title).toBe("Hello")

  const forKey = shapeFor(openKey(), envelope)
  expect(forKey).not.toBeNull()
  expect(Object.keys(forKey?.data ?? {}).sort()).toEqual(["id", "slug", "type"])
  expect(forKey?.data.secret).toBeUndefined()
  expect(forKey?.data.title).toBeUndefined()

  // A draft being saved is not a website's business at all.
  expect(shapeFor(openKey(), { ...envelope, event: "entry.updated" })).toBeNull()
  expect(shapeFor(openKey(), { ...envelope, event: "presence" })).toBeNull()
  // The same event still reaches an editor.
  expect(shapeFor(editor, { ...envelope, event: "entry.updated" })).not.toBeNull()
})

test("inbound frames are rejected unless they are well formed", () => {
  expect(readInbound(JSON.stringify({ action: "ping" }))).toEqual({ action: "ping" })
  expect(readInbound(JSON.stringify({ action: "subscribe", topic: "site" }))).toEqual({
    action: "subscribe",
    topic: "site",
  })

  expect(readInbound("not json")).toBeNull()
  expect(readInbound(JSON.stringify({ action: "subscribe" }))).toBeNull()
  expect(readInbound(JSON.stringify({ action: "subscribe", topic: "entry:nope" }))).toBeNull()
  expect(readInbound(JSON.stringify({ action: "drop table" }))).toBeNull()
  // Bounded, so a socket can't be used to push a megabyte through JSON.parse.
  expect(readInbound(`{"action":"ping","pad":"${"x".repeat(5_000)}"}`)).toBeNull()
})

test("a ticket works exactly once and stops working when it expires", () => {
  const store = createTicketStore<Audience>(50)

  const issued = store.issue(editor)
  expect(store.size()).toBe(1)

  expect(store.redeem(issued.value)).toEqual(editor)
  // Replaying the handshake gets nothing — this is why a leaked ticket is inert.
  expect(store.redeem(issued.value)).toBeNull()
  expect(store.size()).toBe(0)

  expect(store.redeem("inkrt_never-issued")).toBeNull()
})

test("an expired ticket is refused even though it was never redeemed", async () => {
  const store = createTicketStore<Audience>(1)
  const issued = store.issue(editor)

  await new Promise(resolve => setTimeout(resolve, 15))

  expect(store.redeem(issued.value)).toBeNull()
})
