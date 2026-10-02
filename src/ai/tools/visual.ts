import { from } from "atlas/db"
import { can } from "../../auth/roles.ts"
import { byId as typeById } from "../../contenttypes/index.ts"
import type { EntryRow } from "../../entries/index.ts"
import { decodeObject } from "../../json/index.ts"
import { entries } from "../../schema/index.ts"
import { readLayout } from "../../visual/layout.ts"
import type { Tool } from "./common.ts"
import { fail, text } from "./common.ts"

export const visualTools: readonly Tool[] = [
  {
    name: "get_page_layout",
    description:
      "Read the real visual sections of a page and their current order and visibility. Only these sections can be moved or hidden on this page. Use propose_entry_update with data.__layout containing order and hidden arrays of section ids to propose changes. Preserve the current hidden list and order unless asked to change them. Fixed sections keep their positions even when their ids appear in order; never promise to move them. This changes one page, not its content type.",
    input_schema: {
      type: "object",
      properties: { entryId: { type: "string" } },
      required: ["entryId"],
      additionalProperties: false,
    },
    needs: can.readContent,
    run: async (run, input) => {
      const entry = await run.db.one<EntryRow>(
        from(entries)
          .where(q => q("id").equals(text(input, "entryId")))
          .where(q => q("deleted_at").isNull()),
      )
      if (!entry) return fail("No entry with that id. Call list_entries to find the page.")
      const type = await typeById(run.db, entry.content_type_id)
      const page = type ? run.visual?.[type.name] : undefined
      if (!page)
        return fail(
          "This page has no visual sections available. Its content can still be edited with get_entry and propose_entry_update.",
        )
      return {
        output: {
          entryId: entry.id,
          title: entry.title,
          sections: page.sections.map(section => ({
            id: section.id,
            label: section.label,
            fields: section.fields,
            movable: section.movable !== false,
          })),
          current: readLayout(decodeObject(entry.data).__layout),
        },
      }
    },
  },
]
