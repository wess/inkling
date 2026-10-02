import { from } from "atlas/db"
import { can } from "../../auth/roles.ts"
import { byId as typeById } from "../../contenttypes/index.ts"
import { rows } from "../../db/dialect.ts"
import type { EntryRow } from "../../entries/index.ts"
import { decodeObject } from "../../json/index.ts"
import { entries, revisions } from "../../schema/index.ts"
import type { Tool } from "./common.ts"
import { clampLimit, fail, queued, text } from "./common.ts"

// Undo. Handing an assistant the whole site is only reasonable if every change
// it makes can be taken back, and the admin already keeps the means: a revision
// is snapshotted *before* each save, and a deleted entry waits in the trash.
// These tools give Inky the same two ways back, as proposals like everything
// else — so "put that back" is something a person approves, not something that
// happens behind them.

type RevisionRow = {
  id: string
  entry_id: string
  title: string
  data: string
  status: string
  note: string | null
  created_at: string
}

type RevisionListRow = RevisionRow & { author_name: string | null }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export const historyTools: readonly Tool[] = [
  {
    name: "list_revisions",
    description:
      "The saved history of one entry, newest first. A revision is the state of the page *before* a save, so the newest one is what the page looked like before its most recent edit — restoring it is how you undo that edit. Use this when asked to undo, revert, or put something back.",
    input_schema: {
      type: "object",
      properties: {
        entryId: { type: "string" },
        limit: { type: "number", description: "How many, default 20." },
      },
      required: ["entryId"],
      additionalProperties: false,
    },
    needs: can.readContent,
    run: async (run, input) => {
      const history = await rows<RevisionListRow>(
        run.db,
        from("revisions", "r")
          .leftJoin("users", "u.id = r.author_id", "u")
          .select("r.id", "r.title", "r.status", "r.note", "r.created_at", "u.name as author_name")
          .where(q => q("r.entry_id").equals(text(input, "entryId")))
          .orderBy("r.created_at", "DESC")
          .limit(clampLimit(input.limit)),
      )
      return {
        output: history.map(row => ({
          id: row.id,
          title: row.title,
          status: row.status,
          note: row.note,
          savedBy: row.author_name,
          savedAt: row.created_at,
        })),
      }
    },
  },

  {
    name: "propose_revision_restore",
    description:
      'Propose putting an entry back to how it was in a saved revision from list_revisions. The person sees exactly which fields change. Restoring is itself an edit that is saved first, so it can be undone too. Say which edit you are undoing, in the person\'s terms ("the headline change from this morning").',
    input_schema: {
      type: "object",
      properties: {
        revisionId: { type: "string" },
        summary: { type: "string", description: "One line, for the person: what this undoes." },
      },
      required: ["revisionId", "summary"],
      additionalProperties: false,
    },
    needs: can.writeContent,
    run: async (run, input) => {
      const revision = await run.db.one<RevisionRow>(
        from(revisions).where(q => q("id").equals(text(input, "revisionId"))),
      )
      if (!revision) return fail("No revision with that id. Call list_revisions for the entry.")

      const entry = await run.db.one<EntryRow>(
        from(entries)
          .where(q => q("id").equals(revision.entry_id))
          .where(q => q("deleted_at").isNull()),
      )
      if (!entry) return fail("That page is in the trash. Restore it from the trash first.")

      const type = await typeById(run.db, entry.content_type_id)
      const current = decodeObject(entry.data)
      const past = decodeObject(revision.data)

      // Only what would actually move, so the card reads as the change it is.
      const patch: Record<string, unknown> = {}
      const before: Record<string, unknown> = {}
      if (revision.title !== entry.title) {
        patch.title = revision.title
        before.title = entry.title
      }
      for (const key of new Set([...Object.keys(current), ...Object.keys(past)])) {
        if (same(current[key], past[key])) continue
        patch[key] = past[key] ?? null
        before[key] = current[key] ?? null
      }
      if (Object.keys(patch).length === 0) return fail("The page already matches that revision. Nothing to restore.")

      run.queue({
        kind: "entry.restore",
        summary: text(input, "summary") || "Put this page back how it was",
        revisionId: revision.id,
        entryId: entry.id,
        entryTitle: entry.title,
        typeName: type?.name ?? "",
        savedAt: revision.created_at,
        patch,
        before,
      })
      return queued()
    },
  },

  {
    name: "list_trash",
    description:
      "Entries that were deleted and can still be brought back, newest first. Use it when asked to undo a deletion or find something that went missing.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number" } },
      additionalProperties: false,
    },
    needs: can.writeContent,
    run: async (run, input) => {
      const gone = await run.db.all<EntryRow>(
        from(entries)
          .where(q => q("deleted_at").isNotNull())
          .orderBy("deleted_at", "DESC")
          .limit(clampLimit(input.limit)),
      )
      return {
        output: gone.map(row => ({
          id: row.id,
          title: row.title,
          slug: row.slug,
          status: row.status,
          deletedAt: row.deleted_at,
        })),
      }
    },
  },

  {
    name: "propose_entry_untrash",
    description:
      "Propose bringing a deleted entry back from the trash, from list_trash. It returns as it was before it was deleted.",
    input_schema: {
      type: "object",
      properties: {
        entryId: { type: "string" },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["entryId", "summary"],
      additionalProperties: false,
    },
    needs: can.writeContent,
    run: async (run, input) => {
      const entry = await run.db.one<EntryRow>(
        from(entries)
          .where(q => q("id").equals(text(input, "entryId")))
          .where(q => q("deleted_at").isNotNull()),
      )
      if (!entry) return fail("That entry is not in the trash. Call list_trash.")
      const type = await typeById(run.db, entry.content_type_id)

      run.queue({
        kind: "entry.untrash",
        summary: text(input, "summary") || `Bring back "${entry.title}"`,
        entryId: entry.id,
        entryTitle: entry.title,
        typeName: type?.name ?? "",
      })
      return queued()
    },
  },
]
