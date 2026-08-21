import type { Connection } from "atlas/db"
import type { Capability, Scope } from "../../auth/roles.ts"
import type { Field } from "../../fields/index.ts"
import type { Registry } from "../../plugins/index.ts"

// What the agent is allowed to know and allowed to ask for.
//
// The split here is the whole safety model, so it is worth stating plainly:
// every tool is a *read*. The agent cannot write, and there is no flag that
// makes it able to — a change reaches the site only when a person clicks Apply
// in the admin, which sends it back through the ordinary admin route like any
// other edit. That keeps one write path in the codebase, so validation,
// revisions, slug uniqueness, relation checks, hooks, and the audit trail all
// keep working without a second implementation to keep honest.
//
// The "write" tools the model sees (`propose_*`) therefore do nothing but
// record an intention and hand it to the UI.

export type ToolResult = { readonly output: unknown; readonly isError?: boolean }

// What the route supplies. `role` is the asking person's, and it decides which
// tools exist at all — see `toolsFor`.
export type ToolContext = {
  readonly db: Connection
  readonly role: string
  readonly registry: Registry
  readonly proposals: Proposal[]
}

// What a handler gets. `queue` is the only way to record a proposal, so id and
// capability stamping happen once rather than in twenty places.
export type ToolRun = ToolContext & {
  readonly queue: (draft: ProposalDraft) => void
}

// A tool is its schema and its handler in one object, because the two drift
// apart the moment they live in different lists.
export type Tool = {
  readonly name: string
  readonly description: string
  readonly input_schema: Record<string, unknown>
  // What the person must be allowed to do for this tool to exist. It is the
  // capability the *apply* route will check, so offering a tool without it
  // would only teach Inky to queue work that dead-ends in a 403.
  readonly needs: Capability
  readonly run: (run: ToolRun, input: Record<string, unknown>) => Promise<ToolResult>
}

// A change the agent wants made, in the shape the admin already knows how to
// send. `summary` is the model's own one-line description; it is shown to the
// person, never trusted as a description of what the payload does. `needs` is
// what applying it will require, so the admin can grey out a card rather than
// let someone press a button that refuses them.
type Base = {
  readonly id: string
  readonly summary: string
  readonly needs: Scope
}

export type Proposal =
  | (Base & {
      readonly kind: "entry.update"
      readonly entryId: string
      readonly entryTitle: string
      readonly typeName: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "entry.create"
      readonly typeName: string
      readonly payload: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "entry.status"
      readonly entryId: string
      readonly entryTitle: string
      readonly from: string
      readonly to: string
    })
  | (Base & {
      readonly kind: "entry.delete"
      readonly entryId: string
      readonly entryTitle: string
      readonly typeName: string
    })
  | (Base & {
      readonly kind: "entry.terms"
      readonly entryId: string
      readonly entryTitle: string
      readonly termIds: string[]
      readonly labels: string[]
      readonly before: string[]
    })
  | (Base & {
      readonly kind: "type.update"
      readonly typeName: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "type.create"
      readonly typeName: string
      readonly payload: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "media.update"
      readonly mediaId: string
      readonly filename: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "taxonomy.create"
      readonly payload: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "term.create"
      readonly taxonomyName: string
      readonly taxonomyLabel: string
      readonly payload: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "settings.update"
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "menu.update"
      readonly menuName: string
      readonly menuLabel: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "menu.create"
      readonly menuLabel: string
      readonly items: unknown[]
    })
  | (Base & {
      readonly kind: "menu.delete"
      readonly menuName: string
      readonly menuLabel: string
    })
  | (Base & {
      readonly kind: "plugin.state"
      readonly pluginName: string
      readonly pluginLabel: string
      readonly enabled: boolean
    })
  | (Base & {
      readonly kind: "plugin.settings"
      readonly pluginName: string
      readonly pluginLabel: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "person.role"
      readonly userId: string
      readonly personName: string
      readonly from: string
      readonly to: string
    })
  | (Base & {
      readonly kind: "key.create"
      readonly payload: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "webhook.create"
      readonly payload: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "webhook.update"
      readonly webhookId: string
      readonly webhookName: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "social.app"
      readonly network: string
      readonly networkLabel: string
      readonly patch: Record<string, unknown>
      readonly before: Record<string, unknown>
    })
  | (Base & {
      readonly kind: "social.post"
      readonly payload: Record<string, unknown>
      readonly accounts: string[]
    })
  // Not a change at all: a card that takes the person to the one screen where
  // they can finish something only a human can do — press Connect, paste a
  // secret, upload a file. Inky's alternative is a sentence naming a screen the
  // person then has to go and find.
  | (Base & {
      readonly kind: "admin.open"
      readonly screen: string
      readonly typeName?: string
      readonly entryId?: string
      readonly label: string
    })

// `needs` is optional on the way in: `runTool` stamps the tool's own capability
// unless a handler had a reason to differ — publishing an entry needs more than
// drafting one, and it is the same tool.
type Draft<T> = T extends unknown ? Omit<T, "id" | "needs"> & { needs?: Scope } : never
export type ProposalDraft = Draft<Proposal>

export const proposalId = (): string => `p_${Math.random().toString(36).slice(2, 10)}`

// Errors are returned as text rather than thrown: a tool that fails should let
// the model correct itself on the next step, not end the run.
export const fail = (message: string): ToolResult => ({ output: { error: message }, isError: true })

export const queued = (note = "Shown to the person for review. Do not queue it again."): ToolResult => ({
  output: { queued: true, note },
})

export const MAX_ROWS = 50
const MAX_FIELD_EXCERPT = 4_000

export const clampLimit = (raw: unknown): number => {
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 20
  return Math.min(Math.floor(value), MAX_ROWS)
}

export const text = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" ? (input[key] as string).trim() : ""

export const record = (input: Record<string, unknown>, key: string): Record<string, unknown> =>
  input[key] !== null && typeof input[key] === "object" && !Array.isArray(input[key])
    ? (input[key] as Record<string, unknown>)
    : {}

export const list = (input: Record<string, unknown>, key: string): string[] =>
  Array.isArray(input[key]) ? (input[key] as unknown[]).filter((v): v is string => typeof v === "string") : []

// Media and reference fields hold ids, which tell the model nothing on their
// own; long bodies are trimmed because the agent needs the gist and the shape,
// not every byte.
export const readableData = (fields: readonly Field[], data: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const value = data[field.key]
    if (value === null || value === undefined || value === "") continue
    out[field.key] = typeof value === "string" ? value.slice(0, MAX_FIELD_EXCERPT) : value
  }
  return out
}

export type FieldShape = {
  key: string
  type: string
  label: string
  required: boolean
  help?: string
  options?: string[]
  of?: string
  fields?: FieldShape[]
}

export const fieldShape = (fields: readonly Field[]): FieldShape[] =>
  fields.map(field => ({
    key: field.key,
    type: field.type,
    label: field.label,
    required: field.required ?? false,
    help: field.help,
    options: field.options?.map(option => option.value),
    of: field.of,
    fields: field.fields ? fieldShape(field.fields) : undefined,
  }))
