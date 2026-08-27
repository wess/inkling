import { from } from "atlas/db"
import { badRequest, del, get, json, notFound, parseJson, pipeline, post, redirect } from "atlas/server"
import { auth, requireAuth, requireCan } from "../../src/auth/guard.ts"
import { can } from "../../src/auth/roles.ts"
import { corsAll } from "../../src/http/index.ts"
import { requireApiKey } from "../../src/keys/index.ts"
import { consentUrl, exchange, readState } from "../../src/oauth/index.ts"
import type { PluginStats } from "../../src/plugins/define.ts"
import { definePlugin } from "../../src/plugins/define.ts"
import { users } from "../../src/schema/index.ts"
import { accessible, summarize as summarizeAds } from "./ads.ts"
import { measurementIdFor, properties, summarize as summarizeAnalytics } from "./analytics.ts"
import { detail, GoogleError, getJson } from "./api.ts"
import {
  CONSENT_EXTRA,
  clientFor,
  digits,
  settings as readSettings,
  redirectUri,
  SCOPE_ADS,
  SETTING_KEYS,
} from "./config.ts"
import { accessToken, byId as connectionById, current, granted, remove, save } from "./connection.ts"
import type { Choice, State } from "./guide.ts"
import { build as buildGuide } from "./guide.ts"
import { complaints, tagFor } from "./tag.ts"

// Google, all of it, in one plugin — and split down the middle on purpose.
//
// The half almost everybody wants is a text box: paste a Measurement ID and the
// site is measured. It needs no account, no Google Cloud project and nothing
// approved, and the Setup screen presents it as complete on its own.
//
// The other half — reading traffic and ad spend back into these panels — needs
// a connected Google account, and it is marked optional everywhere it appears.
// The distinction matters more than any code here: sold as one thing, this is
// an hour in a developer console that most sites do not need, and people either
// do all of it or none of it. Sold as two, the first one takes five minutes.
//
// See ./guide.ts, which is the actual product for someone who has not done this
// before, and ./config.ts for what "set up" means at each level.

type Pending = { readonly userId: string }

const CONNECTION_ID = "google"

const range = (value: unknown, fallback: number): number => Math.min(Math.max(Number(value) || fallback, 1), 365)

// Google's own sentence, or ours when there was not one. Every failure in this
// plugin is a configuration mistake somewhere else, and Google names it.
const said = (error: unknown): string =>
  error instanceof GoogleError ? error.message : error instanceof Error ? error.message : "Google refused that request."

export default definePlugin({
  name: "google",
  version: "1.0.0",
  label: "Google",
  description: "Google Analytics and Google Ads: the tag for your site, and the numbers back inside Inkling.",
  author: "Inkling",

  settings: [
    {
      key: "measurementId",
      label: "Measurement ID",
      type: "text",
      default: "",
      help: "Puts Google Analytics on your site. This on its own is a working setup.",
      find: "Google Analytics → **Admin** → **Data streams** → your website. Top right, starts with **G-**.",
    },
    {
      key: "containerId",
      label: "Tag Manager container",
      type: "text",
      default: "",
      help: "Optional. When set, this is served instead of the Analytics tag.",
      find: "Top of the Google Tag Manager screen. Starts with **GTM-**.",
    },
    {
      key: "adsConversionId",
      label: "Ads conversion ID",
      type: "text",
      default: "",
      help: "Optional. Adds Google Ads conversion tracking to the same snippet.",
      find: "Google Ads → **Goals** → **Conversions** → **Google tag**. Starts with **AW-**.",
    },
    {
      key: "clientId",
      label: "OAuth client ID",
      type: "text",
      default: "",
      help: "Only needed to read numbers back into Inkling. Nothing on your site depends on it.",
      find: "Google Cloud console → **APIs & Services** → **Credentials**. Ends with **.apps.googleusercontent.com**.",
    },
    {
      key: "clientSecret",
      label: "OAuth client secret",
      type: "secret",
      default: "",
      help: "Stored encrypted. Shown only as its last four characters from here on.",
      find: "Shown once, beside the client ID, when you create the OAuth client.",
    },
    {
      key: "propertyId",
      label: "Analytics property",
      type: "text",
      default: "",
      help: "Which website's numbers the Traffic panel reads. Easier to pick on the Setup screen.",
      find: "The number in **properties/123456789**, under Admin → Property settings.",
    },
    {
      key: "adsDeveloperToken",
      label: "Ads developer token",
      type: "secret",
      default: "",
      help: "Stored encrypted. Required for the Ads panel and nothing else.",
      find: "Google Ads → **Tools** → **Setup** → **API Center**, on a manager account.",
    },
    {
      key: "adsCustomerId",
      label: "Ads account",
      type: "text",
      default: "",
      help: "The account that runs the ads, not the manager account above it.",
      find: "Ten digits at the top right of Google Ads. Dashes are fine.",
    },
    {
      key: "adsLoginCustomerId",
      label: "Ads manager account",
      type: "text",
      default: "",
      help: "Only when the account above is reached through a manager account.",
      find: "Ten digits at the top right of the manager account.",
    },
    {
      key: "adsApiVersion",
      label: "Ads API version",
      type: "text",
      default: "",
      help: "Leave this empty unless Google tells you a version is being turned off.",
    },
  ],

  panels: [
    {
      id: "setup",
      label: "Setup",
      icon: "list-checks",
      kind: "guide",
      endpoint: "/ext/google/setup",
      description: "What to do, in order, and how far along you are.",
    },
    {
      id: "traffic",
      label: "Traffic",
      icon: "activity",
      kind: "stats",
      endpoint: "/ext/google/analytics",
      ranges: [7, 30, 90],
      description: "Google Analytics, read back into Inkling.",
    },
    {
      id: "ads",
      label: "Ads",
      icon: "megaphone",
      kind: "stats",
      endpoint: "/ext/google/ads",
      ranges: [7, 30, 90],
      description: "What Google Ads spent, and what it bought.",
    },
    {
      id: "account",
      label: "Google account",
      icon: "key",
      kind: "connections",
      endpoint: "/ext/google/connections",
      description: "The account these panels read through.",
    },
    {
      id: "googlesettings",
      label: "Google settings",
      icon: "sliders",
      kind: "settings",
      description: "Every value the Setup screen collects, in one list.",
    },
  ],

  routes: ctx => {
    const reading = pipeline(requireAuth(ctx.db), requireCan(can.manageSettings, "read Google reports"))
    const configuring = pipeline(requireAuth(ctx.db), requireCan(can.manageSettings, "configure Google"))
    const configuringJson = pipeline(requireAuth(ctx.db), requireCan(can.manageSettings, "configure Google"), parseJson)

    // Every panel needs the same three things, and two of them are one query.
    const state = async () => {
      const config = await readSettings(ctx)
      const row = await current(ctx.db)
      return { config, row, client: clientFor(config) }
    }

    // An access token or a reason there is not one. Never throws: a panel with
    // no connection has something to say, not something to crash about.
    const token = async (): Promise<{ token: string | null; why: string }> => {
      const { config, row, client } = await state()
      if (!config.clientId || !config.clientSecret) {
        return { token: null, why: "No Google account is connected yet. Open **Setup** to do it — it is optional." }
      }
      if (!row) return { token: null, why: "No Google account is connected yet. Open **Setup**." }
      if (row.error) return { token: null, why: row.error }

      const live = await accessToken(ctx.db, row, client)
      return live
        ? { token: live, why: "" }
        : { token: null, why: "That Google connection needs renewing. Open **Setup** and press Reconnect." }
    }

    return [
      // ------------------------------------------------------------- the tag
      //
      // What a website asks for. Key-authenticated like every other read from
      // beyond the admin, and cheap enough to fetch on every build.
      get(
        "/tag",
        pipeline(
          corsAll,
          requireApiKey(ctx.db),
        )(async c => {
          const config = await readSettings(ctx)
          const tag = tagFor(config)
          return json(c, 200, {
            data: {
              kind: tag.kind,
              ids: tag.ids,
              head: tag.head,
              body: tag.body,
              measurementId: config.measurementId,
              containerId: config.containerId,
              adsConversionId: config.adsConversionId,
            },
          })
        }),
      ),

      // ----------------------------------------------------------- the guide
      get(
        "/setup",
        configuring(async c => {
          const { config, row } = await state()
          const adsGranted = granted(row, SCOPE_ADS)

          const live = await token()

          // Both lists are best-effort. A failure here is a step somebody has
          // not done yet as often as it is a fault, so it becomes the empty
          // message on the choice rather than an error on the whole screen.
          const [propertyList, adsList] = await Promise.all([
            (async (): Promise<{ options: Choice[]; error: string | null }> => {
              if (!live.token) return { options: [], error: null }
              try {
                const found = await properties(live.token)
                return {
                  options: found.map(item => ({ value: item.id, label: item.name, hint: item.account })),
                  error: null,
                }
              } catch (error) {
                return { options: [], error: said(error) }
              }
            })(),
            (async (): Promise<{ options: Choice[]; error: string | null }> => {
              if (!live.token || !config.adsDeveloperToken || !adsGranted) return { options: [], error: null }
              try {
                const found = await accessible(
                  live.token,
                  config.adsApiVersion,
                  config.adsDeveloperToken,
                  config.adsLoginCustomerId,
                )
                return {
                  options: found.map(item => ({
                    value: item.id,
                    label: item.name,
                    hint: item.manager ? "manager account — holds no spend" : item.id,
                  })),
                  error: null,
                }
              } catch (error) {
                return { options: [], error: said(error) }
              }
            })(),
          ])

          const guide: State = {
            settings: config,
            tag: tagFor(config),
            redirectUri: redirectUri(),
            connected: row ? { account: row.account, error: row.error } : null,
            adsGranted,
            properties: propertyList,
            adsAccounts: adsList,
          }

          const built = buildGuide(guide)
          const wrong = complaints(config)

          return json(c, 200, {
            data: { ...built, gotchas: [...wrong, ...(built.gotchas ?? [])] },
          })
        }),
      ),

      // One setting, from a guide step. The guide is the only screen that uses
      // this; the settings panel writes through the core plugin settings route.
      post(
        "/set/:key",
        configuringJson(async c => {
          const key = String(c.params.key ?? "")
          if (!(SETTING_KEYS as readonly string[]).includes(key)) {
            throw notFound(`Google has no setting called "${key}"`)
          }

          const body = (c.body ?? {}) as Record<string, unknown>
          const value = typeof body.value === "string" ? body.value.trim() : ""
          await ctx.setSetting(key, value)

          // Choosing a property is also where the Measurement ID can be filled
          // in, because Google already knows it and asking someone to go and
          // find the same thing twice is how a setup screen loses people.
          if (key === "propertyId" && value) {
            const live = await token()
            const config = await readSettings(ctx)
            if (live.token && !config.measurementId) {
              const found = await measurementIdFor(digits(value), live.token).catch(() => "")
              if (found) await ctx.setSetting("measurementId", found)
            }
          }

          return json(c, 200, { data: { key } })
        }),
      ),

      // ------------------------------------------------------ the connection
      get(
        "/connections",
        configuring(async c => {
          const { config, row } = await state()
          const configured = config.clientId !== "" && config.clientSecret !== ""

          return json(c, 200, {
            data: {
              redirectUri: redirectUri(),
              connections: [
                {
                  id: CONNECTION_ID,
                  label: "Google",
                  configured,
                  hint: "Add an OAuth client ID and secret on the Setup screen to offer this. Your site is measured without it.",
                  scopes: config.adsDeveloperToken ? ["Analytics (read)", "Google Ads (read)"] : ["Analytics (read)"],
                  connection: row
                    ? {
                        id: row.id,
                        account: row.account,
                        expiresAt: row.expires_at,
                        error: row.error,
                        connectedAt: row.connected_at,
                      }
                    : null,
                },
              ],
            },
          })
        }),
      ),

      // Returns the consent URL rather than redirecting: the caller is the
      // admin on a fetch, and a 302 to Google would be followed by the fetch
      // rather than by the browser's address bar.
      post(
        "/connections/:id/start",
        configuring(async c => {
          const { client } = await state()
          if (!client) {
            throw badRequest(
              "Google needs an OAuth client ID and secret before it can be connected. The Setup screen walks through making one.",
              { code: "NO_OAUTH_CLIENT" },
            )
          }

          const { url, expiresAt } = await consentUrl<Pending>(
            client,
            redirectUri(),
            { userId: auth(c).id },
            CONSENT_EXTRA,
          )
          return json(c, 200, { data: { url, expiresAt } })
        }),
      ),

      del(
        "/connections/:id",
        configuring(async c => {
          const row = await connectionById(ctx.db, String(c.params.id ?? ""))
          if (!row) throw notFound("That connection no longer exists")
          await remove(ctx.db, row.id)
          return json(c, 200, { data: { id: row.id } })
        }),
      ),

      // Public, because the browser arrives here by top-level navigation from
      // Google carrying no bearer token for a fetch to attach. What stands in
      // for a session is the sealed `state`: it names the admin who started the
      // flow, expires in ten minutes, and cannot be minted without SECRET. The
      // capability is re-read on the way through, so an account demoted
      // mid-flow cannot finish it.
      get("/callback", async c => {
        const home = ctx.adminBase === "/" ? "" : ctx.adminBase
        const back = (outcome: string, reason?: string) =>
          redirect(
            c,
            `${home}/plugins/google/setup?connected=${encodeURIComponent(outcome)}` +
              (reason ? `&reason=${encodeURIComponent(reason.slice(0, 300))}` : ""),
          )

        const denied = typeof c.query.error === "string" ? c.query.error : ""
        if (denied) return back("error", String(c.query.error_description ?? denied))

        const pending = await readState<Pending>(typeof c.query.state === "string" ? c.query.state : "")
        if (!pending) return back("error", "That connection link expired or was not issued by this site")

        const code = typeof c.query.code === "string" ? c.query.code : ""
        if (!code) return back("error", "Google returned no authorization code")

        const { config, client } = await state()
        if (!client) return back("error", "The Google OAuth client is no longer configured")

        const actor = await ctx.db.one<{ id: string; role: string; deleted_at: string | null }>(
          from(users).where(q => q("id").equals(pending.userId)),
        )
        if (!actor || actor.deleted_at || !can.manageSettings(actor.role)) {
          return back("error", "That account may no longer connect Google")
        }

        try {
          const tokens = await exchange(client, redirectUri(), code, pending.verifier)

          // Naming the account is cosmetic here, unlike a social connection
          // where the token belongs to a page rather than a person. A Google
          // account that will not say its own address still reads reports, so a
          // failure here does not refuse the connection.
          const who = await getJson("https://www.googleapis.com/oauth2/v3/userinfo", tokens.accessToken).catch(
            () => ({}) as Record<string, unknown>,
          )
          const account = typeof who.email === "string" ? who.email : null

          await save(ctx.db, {
            clientId: config.clientId,
            account,
            userId: actor.id,
            meta: { grantedScopes: tokens.scope ?? "" },
            tokens,
          })

          // One property and none chosen is not a decision anybody wants to be
          // asked to make, so it is made for them — and said out loud on the
          // Setup screen, where it can be changed.
          if (!config.propertyId) {
            const found = await properties(tokens.accessToken).catch(() => [])
            if (found.length === 1 && found[0]) {
              await ctx.setSetting("propertyId", found[0].id)
              if (!config.measurementId) {
                const measurement = await measurementIdFor(found[0].id, tokens.accessToken).catch(() => "")
                if (measurement) await ctx.setSetting("measurementId", measurement)
              }
            }
          }

          return back("ok", account ?? "your Google account")
        } catch (error) {
          return back("error", error instanceof Error ? detail(error.message) : "Google refused the connection")
        }
      }),

      // ---------------------------------------------------------- the panels
      get(
        "/analytics",
        reading(async c => {
          const days = range(c.query.days, 30)
          const { config } = await state()
          const tag = tagFor(config)

          const live = await token()
          if (!live.token) {
            return json(c, 200, {
              data: {
                note:
                  tag.kind === "none"
                    ? `${live.why} Your site is not being measured yet either — the first step on **Setup** takes about five minutes.`
                    : `Your site **is** being measured; these numbers are in Google's own reports. ${live.why}`,
                tiles: [],
              } satisfies PluginStats,
            })
          }

          if (!config.propertyId) {
            return json(c, 200, {
              data: {
                note: "Connected, but no Analytics property is chosen yet. Pick one on the **Setup** screen.",
                tiles: [],
              } satisfies PluginStats,
            })
          }

          try {
            return json(c, 200, { data: await summarizeAnalytics(config.propertyId, live.token, days) })
          } catch (error) {
            return json(c, 200, { data: { note: said(error), tiles: [] } satisfies PluginStats })
          }
        }),
      ),

      get(
        "/ads",
        reading(async c => {
          const days = range(c.query.days, 30)
          const { config, row } = await state()

          const missing = !config.adsDeveloperToken
            ? "Google Ads needs a developer token, which is a separate thing from the account connection. **Setup** explains where it comes from and how long it takes."
            : !granted(row, SCOPE_ADS)
              ? "The connected Google account has not granted permission to read Ads. Press **Reconnect** on the Setup screen and say yes to the extra permission."
              : !config.adsCustomerId
                ? "Connected, but no Ads account is chosen yet. Pick one on the **Setup** screen."
                : ""

          const live = await token()
          if (!live.token) return json(c, 200, { data: { note: live.why, tiles: [] } satisfies PluginStats })
          if (missing) return json(c, 200, { data: { note: missing, tiles: [] } satisfies PluginStats })

          try {
            return json(c, 200, {
              data: await summarizeAds(live.token, {
                version: config.adsApiVersion,
                customerId: config.adsCustomerId,
                developerToken: config.adsDeveloperToken,
                loginCustomerId: config.adsLoginCustomerId,
                days,
              }),
            })
          } catch (error) {
            return json(c, 200, { data: { note: said(error), tiles: [] } satisfies PluginStats })
          }
        }),
      ),
    ]
  },

  install: async ctx => {
    ctx.log("ready — paste a Measurement ID under Setup and the site is measured; the rest is optional")
  },
})
