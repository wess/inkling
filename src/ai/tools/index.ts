import { can } from "../../auth/roles.ts"
import { accessTools } from "./access.ts"
import type { Tool, ToolContext, ToolResult, ToolRun } from "./common.ts"
import { fail, proposalId, queued, text } from "./common.ts"
import { contentTools } from "./content.ts"
import { siteTools } from "./site.ts"
import { socialTools } from "./social.ts"

export type { Proposal, Tool, ToolContext, ToolResult } from "./common.ts"

// Where the admin can be sent, and what each screen is for in the words of
// somebody who does not know its name. Enumerated rather than free-form: a path
// the model invents is a 404 with a chat message insisting it exists.
const SCREENS: Readonly<Record<string, string>> = {
  dashboard: "the overview of the whole site",
  activity: "the log of every change anyone has made",
  collection: "the list of one kind of page — needs `type`",
  editor: "one page open for editing — needs `type`, and `entryId` for an existing one",
  media: "the media library, the only place a file can be uploaded",
  types: "the shapes pages can take — optionally one of them, with `type`",
  taxonomy: "categories and tags",
  menus: "the navigation menus",
  trash: "deleted content, and where it is restored from",
  settings: "the site-wide details",
  users: "people and their roles, and the only place an account is created",
  keys: "the delivery keys websites read content with",
  agents: "machine credentials for programs",
  webhooks: "outbound webhooks",
  plugins: "installed plugins",
  ai: "the AI providers, and this assistant full-size",
  social: "the social dashboard",
  socialposts: "every social post",
  socialcompose: "writing a social post — `entryId` opens an existing one",
  socialcalendar: "what is going out, by date",
  socialaccounts: "connecting an account to a network — where the Connect button is",
  socialsettings: "the developer-app credentials per network, and where a client secret is pasted",
}

// The one tool that is neither a read nor a proposal. It moves the admin, which
// is the difference between "your logo is under Settings" and being there.
const navigationTool: Tool = {
  name: "open_screen",
  description: `Take the person to a screen in this admin. Use it whenever the next step is somewhere else — after queueing a change they will want to look at, or when the last step is one only a person can do: pressing Connect on a network, pasting a secret, uploading a file, creating an account. Navigate rather than describing where to go. At most one per answer, and say in your reply where you have taken them. Screens: ${Object.entries(
    SCREENS,
  )
    .map(([name, what]) => `${name} (${what})`)
    .join("; ")}.`,
  input_schema: {
    type: "object",
    properties: {
      screen: { type: "string", description: "One of the screen names above." },
      type: { type: "string", description: "A content type's name, for collection, editor, and types." },
      entryId: { type: "string", description: "An entry id for editor, or a post id for socialcompose." },
      label: { type: "string", description: "What the button should say, e.g. “Connect Instagram”." },
      why: { type: "string", description: "One line: what they are going there to do." },
    },
    required: ["screen", "label", "why"],
    additionalProperties: false,
  },
  // Everyone who may use the assistant may also look around the admin, so this
  // is gated at the same place the assistant itself is.
  needs: can.readContent,
  run: async (run, input) => {
    const screen = text(input, "screen")
    if (!SCREENS[screen]) return fail(`No screen called "${screen}". Pick one of: ${Object.keys(SCREENS).join(", ")}.`)
    if ((screen === "collection" || screen === "editor") && !text(input, "type")) {
      return fail(`"${screen}" needs \`type\` — the content type's name.`)
    }

    run.queue({
      kind: "admin.open",
      summary: text(input, "why") || "Take me there",
      screen,
      typeName: text(input, "type") || undefined,
      entryId: text(input, "entryId") || undefined,
      label: text(input, "label") || "Take me there",
    })

    return queued("The admin is moving there now. Say where you have taken them and why.")
  },
}

// Every tool the model can ever be offered. Order is the order it reads them
// in, so the content ones — the overwhelming majority of what is asked for —
// come first.
export const TOOLS: readonly Tool[] = [...contentTools, ...siteTools, ...accessTools, ...socialTools, navigationTool]

const BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]))

// What this person's role can actually reach. Filtering here rather than
// refusing later is the difference between Inky saying "your role cannot do
// that" and Inky confidently queueing a change that meets a 403 on apply.
export const toolsFor = (role: string): readonly Tool[] => TOOLS.filter(tool => tool.needs(role))

// The capabilities a role does *not* hold, named the way the system prompt
// wants to say them. Empty for an owner.
export const outOfReach = (role: string): string[] => {
  const areas: readonly (readonly [string, (r: string) => boolean])[] = [
    ["the shape of pages", can.manageTypes],
    ["categories and tags", can.manageTaxonomy],
    ["navigation menus", can.manageMenus],
    ["the site-wide details", can.manageSettings],
    ["people and roles", can.manageUsers],
    ["delivery keys and webhooks", can.manageKeys],
    ["plugins", can.managePlugins],
    ["social accounts and their setup", can.manageSocial],
  ]
  return areas.filter(([, holds]) => !holds(role)).map(([label]) => label)
}

// A tool spec in the shape the wire wants. Both provider loops read this, and
// neither should know that a handler exists.
export const specsFor = (role: string) =>
  toolsFor(role).map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))

export const runTool = async (
  context: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> => {
  const tool = BY_NAME.get(name)
  if (!tool) return fail(`No tool named "${name}".`)
  // The list was already filtered, so reaching here means the model invented a
  // call. Refusing is cheaper than trusting it.
  if (!tool.needs(context.role)) {
    return fail(`You are working with a ${context.role}, whose role does not allow that.`)
  }

  const run: ToolRun = {
    ...context,
    // Stamping id and capability here is why no handler has to remember
    // either. `needs` is only ever set by a handler whose requirement differs
    // from its tool's — publishing an entry against drafting one.
    queue: draft => {
      context.proposals.push({
        ...draft,
        id: proposalId(),
        needs: draft.needs ?? tool.needs.scope,
      } as (typeof context.proposals)[number])
    },
  }

  return tool.run(run, input)
}
