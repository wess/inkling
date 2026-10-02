import { can } from "../../auth/roles.ts"
import { type Change, checkChange, describeSurfaces, merge, propertyHelp, readRules } from "../../design/index.ts"
import type { Tool } from "./common.ts"
import { fail, queued, text } from "./common.ts"

// How the site looks, as opposed to what it says. The surfaces are the host's
// own vocabulary for its markup, so Inky asks for "buttons" and never sees, let
// alone writes, a selector. See src/design for why the reach is this narrow.

const none = "This site has not exposed anything for Inky to restyle yet."

export const designTools: readonly Tool[] = [
  {
    name: "get_design",
    description:
      "What about the site's look can be changed, and what has been changed already. Returns the surfaces (named parts of the site such as buttons or headings), the properties that can be set on them, and the overrides currently in force. Call it before proposing a design change, and again when asked to undo one.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.manageSettings,
    run: async run => {
      if (Object.keys(run.design).length === 0) return { output: { surfaces: [], note: none } }
      return {
        output: {
          surfaces: describeSurfaces(run.design),
          properties: propertyHelp(),
          current: await readRules(run.db, run.design),
        },
      }
    },
  },

  {
    name: "propose_design_change",
    description:
      'Propose a change to how the site looks: colours, text size and weight, corner rounding, spacing, shadows. Each change sets one property on one surface from get_design, so "make every button black" is one change on the buttons surface with background black, and usually colour white as well so the text stays readable. Set a value to null to remove an override and put that property back to the original design. Batch everything one request needs into a single proposal. This restyles the live site once the person applies it, so say plainly what will look different.',
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line, for the person." },
        changes: {
          type: "array",
          description: "Each one: a surface name, a property, and a value (or null to clear it).",
          items: {
            type: "object",
            properties: {
              surface: { type: "string", description: "A surface name from get_design." },
              property: { type: "string", description: "A property name from get_design." },
              value: { type: ["string", "null"], description: "The new value, or null to clear it." },
            },
            required: ["surface", "property", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "changes"],
      additionalProperties: false,
    },
    needs: can.manageSettings,
    run: async (run, input) => {
      if (Object.keys(run.design).length === 0) return fail(none)
      const raw = Array.isArray(input.changes) ? input.changes : []
      if (raw.length === 0) return fail("Nothing to change — send the changes you want.")

      const changes: Change[] = raw.map(item => {
        const entry = (item ?? {}) as Record<string, unknown>
        return {
          surface: String(entry.surface ?? ""),
          property: String(entry.property ?? ""),
          value: entry.value === null ? null : String(entry.value ?? ""),
        }
      })

      // Rejected here so the model can correct itself with the turn still open,
      // rather than the person meeting the error when they press Apply.
      for (const change of changes) {
        const problem = checkChange(run.design, change)
        if (problem) return fail(problem)
      }

      const current = await readRules(run.db, run.design)
      const before: Record<string, string | null> = {}
      for (const change of changes) {
        const held = current.find(rule => rule.surface === change.surface && rule.property === change.property)
        before[`${change.surface}.${change.property}`] = held?.value ?? null
      }

      // Merged only to learn whether anything would actually move; an identical
      // request is not a proposal worth interrupting someone with.
      const unchanged = JSON.stringify(merge(run.design, current, changes)) === JSON.stringify(current)
      if (unchanged) return fail("The site is already set that way. Nothing to change.")

      run.queue({
        kind: "design.update",
        summary: text(input, "summary") || "Change how the site looks",
        changes,
        before,
      })

      return queued()
    },
  },
]
