import { from } from "atlas/db"
import { can } from "../../auth/roles.ts"
import { config } from "../../config/index.ts"
import { rows } from "../../db/dialect.ts"
import { list as listAccounts, present as presentAccount } from "../../social/accounts.ts"
import { byNetwork as appFor, ready as networkReady, present as presentApp } from "../../social/apps.ts"
import { guideFor, PREAMBLE } from "../../social/guides.ts"
import { NETWORKS, networkFor, networkLabel } from "../../social/networks.ts"
import { redirectUri } from "../../social/oauth.ts"
import { parseIso } from "../../time/index.ts"
import type { Tool } from "./common.ts"
import { clampLimit, fail, list, queued, record, text } from "./common.ts"

// Posting to the networks, and — the part that actually stops people — getting
// each network to issue this install a developer app in the first place.
//
// Two things here are deliberately not proposals. **Connecting an account** is
// a consent screen on the network's own domain, reached by a top-level
// navigation from a button; there is nothing to queue. And the **client secret**
// is a password: the tool accepts one if it is already in the conversation,
// because refusing it then protects nothing, but the description tells Inky to
// send the person to the settings screen to paste it rather than asking them to
// type it into a chat window that reaches a model provider.

type PostRow = {
  id: string
  title: string
  caption: string
  status: string
  scheduled_at: string | null
  updated_at: string
}

export const socialTools: readonly Tool[] = [
  {
    name: "get_social_setup",
    description:
      "Read where this site stands with every social network: whether a developer app is registered, where those credentials came from, whether an account is actually connected, and the redirect URI the network has to be given. Read this before answering anything about social posting — the answer is nearly always that one of those three is missing.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    needs: can.manageSocial,
    run: async run => {
      const accounts = await listAccounts(run.db)
      const networks = await Promise.all(
        NETWORKS.map(async network => {
          const app = presentApp(network.value, await appFor(run.db, network.value))
          const connected = accounts.filter(account => account.network === network.value).map(presentAccount)
          return {
            network: network.value,
            label: network.label,
            // The three states in order, because the next step is whichever of
            // them is false first.
            hasApp: app.source !== "none",
            appSource: app.source,
            clientId: app.clientId || null,
            hasSecret: app.hasSecret,
            secretHint: app.secretHint,
            enabled: app.enabled,
            ready: await networkReady(run.db, network.value),
            accounts: connected.map(account => ({
              id: account.id,
              name: account.account,
              expiresAt: account.expiresAt,
              error: account.error,
            })),
            captionLimit: network.limit,
            media: network.media,
            options: network.options,
            console: network.console,
            help: network.help,
          }
        }),
      )

      return {
        output: {
          // Pasted into every network's console, and it must match to the
          // character — so it is the first thing to quote when asked.
          redirectUri: redirectUri(),
          publicUrl: config.publicUrl,
          networks,
        },
      }
    },
  },

  {
    name: "get_social_guide",
    description:
      "Read the step-by-step for getting a client ID and secret out of one network's developer console — the real button names, how long it takes, and the one step everybody gets wrong. Use it to walk somebody through the setup in your own words, a step at a time, answering what they hit. Do not paste it back at them wholesale.",
    input_schema: {
      type: "object",
      properties: { network: { type: "string", description: "From get_social_setup." } },
      required: ["network"],
      additionalProperties: false,
    },
    needs: can.manageSocial,
    // The only tool that touches nothing: the register is prose in this repo.
    run: async (_run, input) => {
      const network = text(input, "network").toLowerCase()
      const spec = networkFor(network)
      const guide = guideFor(network)
      if (!spec || !guide) {
        return fail(`Inkling does not post to "${network}". Call get_social_setup for the ones it does.`)
      }

      return {
        output: {
          network: spec.value,
          label: spec.label,
          console: spec.console,
          redirectUri: redirectUri(),
          scopes: spec.oauth.scopes,
          // The same four paragraphs precede every guide: what a developer app
          // is, what the two values are, and that none of it posts anything.
          preamble: PREAMBLE,
          summary: guide.summary,
          time: guide.time,
          steps: guide.steps,
          gotchas: guide.gotchas,
        },
      }
    },
  },

  {
    name: "list_social_posts",
    description:
      "List social posts on this site, newest first — drafts, what is scheduled, and what has already gone out.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional: draft, scheduled, posted, partial, or failed." },
        limit: { type: "number", description: "Up to 50. Defaults to 20." },
      },
      additionalProperties: false,
    },
    needs: can.writeSocial,
    run: async (run, input) => {
      let query = from("social_posts", "p").where(q => q("p.deleted_at").isNull())
      const status = text(input, "status")
      if (status) query = query.where(q => q("p.status").equals(status))

      const found = await rows<PostRow>(
        run.db,
        query
          .select(
            "p.id as id",
            "p.title as title",
            "p.caption as caption",
            "p.status as status",
            "p.scheduled_at as scheduled_at",
            "p.updated_at as updated_at",
          )
          .orderBy("p.updated_at", "DESC")
          .limit(clampLimit(input.limit)),
      )

      return {
        output: found.map(row => ({
          id: row.id,
          title: row.title,
          caption: row.caption,
          status: row.status,
          scheduledAt: row.scheduled_at,
          updatedAt: row.updated_at,
        })),
      }
    },
  },

  {
    name: "propose_social_app",
    description:
      "Propose the developer-app credentials for one network, so its Connect button starts working. Ask for the client ID in conversation, but **not** the secret: tell the person to paste that into the field on Social → Settings, because a secret typed into a chat has travelled further than it needed to. Include `clientSecret` here only if they have already put it in the conversation. Leave the URLs and scopes out unless the network told them something different from the defaults.",
    input_schema: {
      type: "object",
      properties: {
        network: { type: "string", description: "From get_social_setup." },
        clientId: { type: "string" },
        clientSecret: { type: "string", description: "Only if it is already in the conversation." },
        authorizeUrl: { type: "string", description: "Only to override the built-in default." },
        tokenUrl: { type: "string", description: "Only to override the built-in default." },
        scopes: { type: "string", description: "Space-separated. Only to override the defaults." },
        enabled: { type: "boolean", description: "Defaults to true." },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["network", "clientId", "summary"],
      additionalProperties: false,
    },
    needs: can.manageSocial,
    run: async (run, input) => {
      const network = text(input, "network").toLowerCase()
      const spec = networkFor(network)
      if (!spec) return fail(`Inkling does not post to "${network}". Call get_social_setup for the ones it does.`)

      const clientId = text(input, "clientId")
      if (!clientId) return fail("A network cannot be switched on without a client id.")

      const patch: Record<string, unknown> = { clientId, enabled: input.enabled !== false }
      // Absent means "keep what is stored" all the way down to the write path,
      // so an empty string here would wipe a secret that is already right.
      if (text(input, "clientSecret")) patch.clientSecret = text(input, "clientSecret")
      for (const key of ["authorizeUrl", "tokenUrl", "scopes"] as const) {
        if (text(input, key)) patch[key] = text(input, key)
      }

      const current = presentApp(network, await appFor(run.db, network))

      run.queue({
        kind: "social.app",
        summary: text(input, "summary") || `Set up ${spec.label}`,
        network,
        networkLabel: spec.label,
        patch,
        before: { clientId: current.clientId || null, hasSecret: current.hasSecret, enabled: current.enabled },
      })

      return queued(
        `Shown for review. Applying it only makes ${spec.label}'s Connect button work — nothing is authorized until they press it on Social → Accounts.`,
      )
    },
  },

  {
    name: "propose_social_post",
    description:
      "Propose a social post as a draft. Targets are connected accounts from get_social_setup — a network with no connected account cannot be a target. Respect each network's caption limit. Never invent a claim, an offer, or a date; if the post needs one you were not given, leave it out and say what is missing.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "For the composer's own list, not published anywhere." },
        caption: { type: "string", description: "The text that goes out, unless a target overrides it." },
        link: { type: "string", description: "Optional URL to include." },
        media: { type: "array", items: { type: "string" }, description: "Media ids from list_media." },
        targets: {
          type: "array",
          description: "Each is { accountId, caption? , options? }. A per-target caption overrides the post's.",
          items: { type: "object", additionalProperties: true },
        },
        scheduledAt: {
          type: "string",
          description: "Optional ISO 8601 date-time in the future. Leave it out to keep the post a draft.",
        },
        summary: { type: "string", description: "One line, for the person." },
      },
      required: ["caption", "targets", "summary"],
      additionalProperties: false,
    },
    needs: can.writeSocial,
    run: async (run, input) => {
      const caption = text(input, "caption")
      if (!caption) return fail("A post needs a caption.")

      const accounts = await listAccounts(run.db)
      const byId = new Map(accounts.map(account => [account.id, account]))

      const targets = (Array.isArray(input.targets) ? input.targets : []).flatMap(raw => {
        const target = (raw ?? {}) as Record<string, unknown>
        const accountId = typeof target.accountId === "string" ? target.accountId : ""
        return accountId ? [{ accountId, target }] : []
      })
      if (targets.length === 0) {
        return fail("Name at least one connected account to post to. Call get_social_setup for what is connected.")
      }

      const missing = targets.filter(entry => !byId.has(entry.accountId)).map(entry => entry.accountId)
      if (missing.length > 0) return fail(`These accounts are not connected: ${missing.join(", ")}.`)

      // The save path refuses a caption a network would truncate, and it is a
      // better refusal here where the model can shorten it.
      for (const entry of targets) {
        const account = byId.get(entry.accountId)
        const spec = account ? networkFor(account.network) : null
        const own = typeof entry.target.caption === "string" ? entry.target.caption : caption
        if (spec && own.length > spec.limit) {
          return fail(`${spec.label} truncates at ${spec.limit} characters and that caption is ${own.length}.`)
        }
      }

      const scheduledAt = text(input, "scheduledAt")
      if (scheduledAt) {
        const parsed = parseIso(scheduledAt)
        if (!parsed) return fail("`scheduledAt` must be an ISO 8601 date-time.")
        if (parsed <= new Date().toISOString()) return fail("`scheduledAt` must be in the future.")
      }

      run.queue({
        kind: "social.post",
        summary: text(input, "summary") || "Draft a post",
        // Writing a post and deciding it goes out are two permissions, and a
        // scheduled post is the second one.
        needs: scheduledAt ? can.publishSocial.scope : can.writeSocial.scope,
        payload: {
          title: text(input, "title") || caption.slice(0, 60),
          caption,
          link: text(input, "link") || null,
          media: list(input, "media"),
          scheduledAt: scheduledAt || null,
          targets: targets.map(entry => ({
            accountId: entry.accountId,
            caption: typeof entry.target.caption === "string" ? entry.target.caption : null,
            options: record(entry.target, "options"),
          })),
        },
        accounts: targets.map(entry => {
          const account = byId.get(entry.accountId)
          return `${networkLabel(account?.network ?? "")}${account?.account_name ? ` · ${account.account_name}` : ""}`
        }),
      })

      return queued(
        "Shown for review. Applying it saves a draft in the composer — nothing reaches an audience until somebody sends it.",
      )
    },
  },
]
