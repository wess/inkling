import { expect, test } from "bun:test"
import { connect, from } from "atlas/db"
import type { Proposal } from "../src/ai/tools/index.ts"
import { runTool, toolsFor } from "../src/ai/tools/index.ts"
import { id } from "../src/ids/index.ts"
import { up } from "../src/migrate/index.ts"
import { contentTypes, entries, revisions } from "../src/schema/index.ts"
import { now } from "../src/time/index.ts"
import { noPlugins } from "./fixtures/registry.ts"

// Undo is what makes giving Inky the whole site reasonable, so it gets the same
// guarantee as everything else it does: it proposes, and nothing moves until a
// person applies it.

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
      fields: JSON.stringify([{ key: "headline", type: "text", label: "Headline" }]),
      icon: null,
      sort_order: 0,
      owner_plugin: null,
      created_at: now(),
      updated_at: now(),
    }),
  )

  const entryId = id()
  const row = {
    id: entryId,
    content_type_id: typeId,
    slug: "home",
    title: "Home",
    data: JSON.stringify({ headline: "We publish books" }),
    status: "published",
    locale: "en",
    author_id: null,
    sort_order: 0,
    published_at: now(),
    scheduled_at: null,
    created_at: now(),
    updated_at: now(),
    deleted_at: null,
  }
  await db.execute(from(entries).insert(row))
  return { db, entryId, row }
}

const run = (db: Awaited<ReturnType<typeof setup>>["db"], proposals: Proposal[], name: string, input: object) =>
  runTool({ db, registry: noPlugins, design: {}, role: "owner", proposals }, name, input as Record<string, unknown>)

test("undoing an edit lists history, then proposes only the fields that would change", async () => {
  const { db, entryId } = await setup()
  const proposals: Proposal[] = []

  // The state before an edit, as the admin snapshots it. The page now says
  // something else.
  const revisionId = id()
  await db.execute(
    from(revisions).insert({
      id: revisionId,
      entry_id: entryId,
      title: "Home",
      data: JSON.stringify({ headline: "We publish books" }),
      status: "published",
      author_id: null,
      note: null,
      created_at: now(),
    }),
  )
  await db.execute(
    from(entries)
      .update({ data: JSON.stringify({ headline: "Buy now!!!" }) })
      .where(q => q("id").equals(entryId)),
  )

  const history = await run(db, proposals, "list_revisions", { entryId })
  expect((history.output as { id: string }[]).map(r => r.id)).toEqual([revisionId])

  const result = await run(db, proposals, "propose_revision_restore", { revisionId, summary: "Undo the headline" })
  expect(result.isError).toBeFalsy()
  expect(proposals).toHaveLength(1)
  const queued = proposals[0] as Extract<Proposal, { kind: "entry.restore" }>
  expect(queued.kind).toBe("entry.restore")
  expect(queued.patch).toEqual({ headline: "We publish books" }) // the title did not change, so it is not listed
  expect(queued.before).toEqual({ headline: "Buy now!!!" })

  // Proposing is inert: the page still says what it said.
  const stored = await db.one<{ data: string }>(from(entries).where(q => q("id").equals(entryId)))
  expect(JSON.parse(stored?.data ?? "{}").headline).toBe("Buy now!!!")
})

test("a revision that already matches the page is not a proposal", async () => {
  const { db, entryId } = await setup()
  const proposals: Proposal[] = []
  const revisionId = id()
  await db.execute(
    from(revisions).insert({
      id: revisionId,
      entry_id: entryId,
      title: "Home",
      data: JSON.stringify({ headline: "We publish books" }),
      status: "published",
      author_id: null,
      note: null,
      created_at: now(),
    }),
  )
  const result = await run(db, proposals, "propose_revision_restore", { revisionId, summary: "x" })
  expect(result.isError).toBe(true)
  expect(proposals).toHaveLength(0)
  expect((await run(db, proposals, "propose_revision_restore", { revisionId: "nope", summary: "x" })).isError).toBe(
    true,
  )
})

test("a deleted page can be found in the trash and brought back, but only while it is there", async () => {
  const { db, entryId } = await setup()
  const proposals: Proposal[] = []

  expect((await run(db, proposals, "propose_entry_untrash", { entryId, summary: "x" })).isError).toBe(true) // not deleted

  await db.execute(
    from(entries)
      .update({ deleted_at: now() })
      .where(q => q("id").equals(entryId)),
  )
  const trash = await run(db, proposals, "list_trash", {})
  expect((trash.output as { id: string }[]).map(e => e.id)).toEqual([entryId])

  expect(
    (await run(db, proposals, "propose_entry_untrash", { entryId, summary: "Bring Home back" })).isError,
  ).toBeFalsy()
  expect(proposals[0]?.kind).toBe("entry.untrash")

  // Restoring from a revision does not resurrect a page that is in the trash.
  const revisionId = id()
  await db.execute(
    from(revisions).insert({
      id: revisionId,
      entry_id: entryId,
      title: "Old",
      data: "{}",
      status: "draft",
      author_id: null,
      note: null,
      created_at: now(),
    }),
  )
  expect((await run(db, proposals, "propose_revision_restore", { revisionId, summary: "x" })).isError).toBe(true)
})

test("undo is offered to anyone who could have made the edit in the first place", () => {
  const names = (role: string) => toolsFor(role).map(tool => tool.name)
  expect(names("author")).toContain("propose_revision_restore")
  expect(names("owner")).toEqual(expect.arrayContaining(["list_revisions", "list_trash", "propose_entry_untrash"]))
})
