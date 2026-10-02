import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import { router } from "atlas/server"
import type { Proposal } from "../src/ai/tools/index.ts"
import { runTool } from "../src/ai/tools/index.ts"
import { issueSession } from "../src/auth/index.ts"
import { entryRoutes } from "../src/entries/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { createHooks } from "../src/plugins/hooks.ts"
import { contentTypes, entries } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { createUser } from "../src/users/index.ts"
import type { VisualPages } from "../src/visual/index.ts"
import { noPlugins } from "./fixtures/registry.ts"

const setup = async (visual: VisualPages = {}) => {
  const db = connect({ driver: "sqlite", path: ":memory:" })
  await up(db, "./migrations")
  const typeId = id()
  await db.execute(
    from(contentTypes).insert({
      id: typeId,
      name: "book",
      label: "Book",
      plural_label: "Books",
      kind: "collection",
      fields: JSON.stringify([
        { key: "author", type: "text", label: "Author", required: true },
        {
          key: "status",
          type: "select",
          label: "Availability",
          options: [
            { value: "available", label: "Available" },
            { value: "outofprint", label: "Out of print" },
          ],
        },
        { key: "cover", type: "media", label: "Cover" },
        {
          key: "editions",
          type: "list",
          label: "Editions",
          fields: [{ key: "format", type: "text", label: "Format" }],
        },
      ]),
      sort_order: 0,
      created_at: now(),
      updated_at: now(),
    }),
  )
  const timestamp = now()
  const add = async (title: string, status = "available") => {
    const entryId = id()
    await db.execute(
      from(entries).insert({
        id: entryId,
        content_type_id: typeId,
        slug: entryId,
        title,
        data: JSON.stringify({ author: "Test Author", status }),
        status: "published",
        locale: "en",
        sort_order: 0,
        published_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      }),
    )
    return entryId
  }
  const proposals: Proposal[] = []
  const call = (name: string, input: Record<string, unknown>) =>
    runTool({ db, role: "owner", registry: noPlugins, design: {}, visual, proposals }, name, input)
  return { db, add, proposals, call }
}

test("catalog review can read past fifty books with availability separate from publication status", async () => {
  const { db, add, call, proposals } = await setup()
  const ids: string[] = []
  for (let index = 0; index < 53; index += 1)
    ids.push(await add(`Book ${index}`, index === 51 ? "outofprint" : "available"))

  type Listed = { id: string; status: string; data: { status: string; author: string } }
  const first = (await call("list_entries", { type: "book", fields: ["status", "author"], limit: 50 }))
    .output as Listed[]
  const second = (await call("list_entries", { type: "book", fields: ["status", "author"], limit: 50, offset: 50 }))
    .output as Listed[]
  expect(first).toHaveLength(50)
  expect(second).toHaveLength(3)
  expect(new Set([...first, ...second].map(row => row.id))).toEqual(new Set(ids))
  const unavailable = [...first, ...second].filter(row => row.data.status === "outofprint")
  expect(unavailable).toHaveLength(1)
  expect(unavailable[0]?.status).toBe("published")
  expect(unavailable[0]?.data.author).toBe("Test Author")
  expect(proposals).toHaveLength(0)
  await db.close()
})

test("invented fields and invalid availability values are corrected before review", async () => {
  const { db, add, call, proposals } = await setup()
  const entryId = await add("A book")
  for (const data of [
    { availability: "outofprint" },
    { status: "out of print" },
    { editions: [{ format: "Hardcover", unavailable: true }] },
    { cover: "an-invented-media-id" },
  ]) {
    const result = await call("propose_entry_update", { entryId, summary: "Change book", data })
    expect(result.isError).toBe(true)
  }
  expect(proposals).toHaveLength(0)
  const stored = await db.one<{ data: string }>(from(entries).where(q => q("id").equals(entryId)))
  expect(JSON.parse(stored?.data ?? "{}").status).toBe("available")

  const result = await call("propose_entry_update", {
    entryId,
    summary: "Mark out of print",
    data: { status: "outofprint" },
  })
  expect(result.isError).toBeUndefined()
  expect(proposals).toHaveLength(1)
  await db.close()
})

test("an availability proposal applies through the normal save route and keeps the other book fields", async () => {
  const { db, add, call, proposals } = await setup()
  const entryId = await add("A book")
  await call("propose_entry_update", { entryId, summary: "Mark out of print", data: { status: "outofprint" } })
  const proposal = proposals[0]
  if (proposal?.kind !== "entry.update") throw new Error("missing update proposal")
  const user = await createUser(db, {
    email: "catalog@example.com",
    name: "Editor",
    password: "a secure test password",
    role: "editor",
  })
  const session = await issueSession(db, user, { ip: "127.0.0.1", userAgent: "tests" })
  const handle = router(
    ...entryRoutes(
      db,
      createHooks(() => {}),
    ),
  )
  const saved = await handle(
    new Request(`http://localhost/entries/${entryId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify(proposal.patch),
    }),
  )
  expect(saved.status).toBe(200)
  const entry = (await saved.json()) as { status: string; data: Record<string, unknown> }
  expect(entry.status).toBe("published")
  expect(entry.data.status).toBe("outofprint")
  expect(entry.data.author).toBe("Test Author")
  await db.close()
})

test("new entry proposals validate required fields and browse rejects unknown field keys", async () => {
  const { db, call, proposals } = await setup()
  expect(
    (
      await call("propose_entry_create", {
        type: "book",
        title: "A book",
        summary: "New book",
        data: { status: "available" },
      })
    ).isError,
  ).toBe(true)
  expect((await call("list_entries", { type: "book", fields: ["availability"] })).isError).toBe(true)
  const publication = await call("list_entries", { type: "book", status: "outofprint" })
  expect(publication.isError).toBe(true)
  expect(JSON.stringify(publication.output)).toContain("publication state")
  expect((await call("list_entries", { type: "book", offset: -1 })).isError).toBe(true)
  expect(proposals).toHaveLength(0)
  await db.close()
})

test("visual section proposals use the declared page sections and remain inert until saved", async () => {
  const { db, add, call, proposals } = await setup({
    book: {
      sections: [
        { id: "heading", label: "Heading", selector: ".heading", fields: [], movable: false },
        { id: "details", label: "Book details", selector: ".details", fields: ["author", "status"] },
        { id: "editions", label: "Editions", selector: ".editions", fields: ["editions"] },
      ],
    },
  })
  const entryId = await add("A book")
  const layout = await call("get_page_layout", { entryId })
  expect(layout.isError).toBeUndefined()
  expect(layout.output).toMatchObject({
    current: { order: [], hidden: [] },
    sections: [
      { id: "heading", movable: false },
      { id: "details", movable: true },
      { id: "editions", movable: true },
    ],
  })
  const proposed = { order: ["heading", "editions", "details"], hidden: ["details"] }
  expect(
    (
      await call("propose_entry_update", {
        entryId,
        summary: "Move editions first and hide details",
        data: { __layout: proposed },
      })
    ).isError,
  ).toBeUndefined()
  expect(proposals[0]).toMatchObject({ kind: "entry.update", patch: { data: { __layout: proposed } } })
  const stored = await db.one<{ data: string }>(from(entries).where(q => q("id").equals(entryId)))
  expect(JSON.parse(stored?.data ?? "{}").__layout).toBeUndefined()

  for (const __layout of [
    { order: ["invented"], hidden: [] },
    { order: ["details"], hidden: ["invented"] },
    { order: ["details", "details"], hidden: [] },
  ])
    expect(
      (await call("propose_entry_update", { entryId, summary: "Invalid layout", data: { __layout } })).isError,
    ).toBe(true)
  expect(proposals).toHaveLength(1)
  await db.execute(
    from(entries)
      .update({ data: JSON.stringify({ author: "Test Author", status: "available", __layout: proposed }) })
      .where(q => q("id").equals(entryId)),
  )
  const show = await call("propose_entry_update", {
    entryId,
    summary: "Show details again",
    data: { __layout: { hidden: [] } },
  })
  expect(show.isError).toBeUndefined()
  expect(proposals[1]).toMatchObject({
    patch: { data: { __layout: { order: ["heading", "editions", "details"], hidden: [] } } },
  })
  await db.close()
})

test("a page with no visual manifest cannot advertise an ineffective layout proposal", async () => {
  const { db, add, call, proposals } = await setup()
  const entryId = await add("A book")
  expect((await call("get_page_layout", { entryId })).isError).toBe(true)
  expect(
    (
      await call("propose_entry_update", {
        entryId,
        summary: "Hide details",
        data: { __layout: { hidden: ["details"] } },
      })
    ).isError,
  ).toBe(true)
  expect(proposals).toHaveLength(0)
  await db.close()
})
