import type { PluginGuide } from "../../src/plugins/define.ts"
import type { Settings } from "./config.ts"
import type { Tag } from "./tag.ts"
import { MEASUREMENT } from "./tag.ts"

// How to actually do this, for someone who has never opened the Google Cloud
// console and has no reason to want to.
//
// The shape of the file is the argument it is making. Google sells all of this
// as one thing, and the setup guides all read as one long list, so people
// conclude that measuring their website requires a Cloud project, an OAuth
// client and a consent screen — and either do all of it or none of it.
//
// It is two jobs. Pasting one id measures the site: five minutes, no account,
// nothing to approve, and it is what almost everybody actually wants. Reading
// the numbers back *inside Inkling* is the expensive one, and it is optional
// forever. So they are separate parts, the expensive ones are marked optional,
// and nothing in the first part mentions the second.
//
// The words are the same register as src/social/guides.ts: short sentences, the
// real names of the real buttons, honest times including the waiting, and the
// one trap each step sets — which is never the step Google's docs emphasize.

export type Choice = { readonly value: string; readonly label: string; readonly hint?: string }

export type State = {
  readonly settings: Settings
  readonly tag: Tag
  readonly redirectUri: string
  readonly connected: { readonly account: string | null; readonly error: string | null } | null
  readonly adsGranted: boolean
  // Discovered from the connected account. `error` is Google's own sentence,
  // shown in place of an empty list, because "no properties found" and "the
  // Analytics API is switched off" look identical otherwise.
  readonly properties: { readonly options: Choice[]; readonly error: string | null }
  readonly adsAccounts: { readonly options: Choice[]; readonly error: string | null }
}

const set = (endpoint: string) => `/ext/google/set/${endpoint}`

const emptyList = (error: string | null, otherwise: string): string => error ?? otherwise

export const build = (state: State): PluginGuide => {
  const { settings, tag } = state
  const live = state.connected !== null && state.connected.error === null

  return {
    summary:
      "There are two halves to this, and the first one is the one most people mean. Paste an id, put a snippet on your site, and Google is measuring it. The second half is optional and always will be — it only changes *where you read the numbers*.",

    parts: [
      {
        title: "Measure your site",
        summary: "No Google Cloud project, no permissions, nothing for Google to approve. One id and one snippet.",
        time: "About five minutes.",
        steps: [
          {
            title: "Make a Google Analytics property, if you have not",
            body: "Sign in at analytics.google.com. First time through, it walks you into making an **account** (your business) and then a **property** (this website) — those are two different things and it asks for both. If somebody already set this up for you, skip straight to the next step.",
            link: { label: "Open Google Analytics", url: "https://analytics.google.com/" },
          },
          {
            title: "Copy your Measurement ID",
            body: "In Analytics, press **Admin** at the bottom of the left-hand menu, then **Data streams**, then the row for your website. The **Measurement ID** is at the top right of the panel that opens, and it looks like **G-ABCD1234**. Paste it here.",
            done: MEASUREMENT.test(settings.measurementId),
            input: {
              endpoint: set("measurementId"),
              value: settings.measurementId,
              placeholder: "G-ABCD1234",
            },
            link: { label: "Open Data streams", url: "https://analytics.google.com/analytics/web/#/a/admin/streams" },
          },
          {
            title: "Put the snippet on your site",
            body:
              tag.kind === "none"
                ? "Fill in the id above and the snippet you need appears here, ready to copy."
                : "Paste this into your site's HTML, as high inside **<head>** as it will go — on every page, which usually means the shared layout or template rather than one page. If your site reads its configuration from Inkling, it can fetch the same thing from **/ext/google/tag** with a delivery key instead of hard-coding it.",
            copy: tag.head || undefined,
          },
          ...(tag.body
            ? [
                {
                  title: "And this second piece, right after <body>",
                  body: "Tag Manager needs a second snippet immediately after the opening **<body>** tag. It is what keeps measurement working for the small number of visitors who block scripts.",
                  copy: tag.body,
                },
              ]
            : []),
          {
            title: "If you use Google Tag Manager",
            body: "Paste your container ID instead — it looks like **GTM-ABCD123** and is at the top of the Tag Manager screen. When a container is set it is the only thing served, because Analytics is nearly always configured inside the container and sending both is what makes every number read exactly double.",
            input: {
              endpoint: set("containerId"),
              value: settings.containerId,
              placeholder: "GTM-ABCD123",
            },
          },
          {
            title: "If you run Google Ads",
            body: "Paste your Ads conversion ID — **AW-123456789**, from Google Ads under **Goals → Conversions → Google tag**. It rides along in the same snippet, so conversions get attributed without a second tag. This is the *tag* id, not the ten-digit customer id at the top right of Google Ads.",
            input: {
              endpoint: set("adsConversionId"),
              value: settings.adsConversionId,
              placeholder: "AW-123456789",
            },
          },
        ],
      },

      {
        title: "Read the numbers inside Inkling",
        optional: true,
        summary:
          "Everything above already works without this. All this changes is where you look: connect a Google account and the Traffic panel here fills in, instead of you opening Google's site to check.",
        time: "About an hour the first time, nearly all of it in Google's Cloud console.",
        steps: [
          {
            title: "Create a Google Cloud project",
            body: "Different site from Analytics, same sign-in. A **project** is just a container for the permission you are about to grant; name it after your site and take every default.",
            link: { label: "Create a project", url: "https://console.cloud.google.com/projectcreate" },
          },
          {
            title: "Switch on the Analytics Data API",
            body: "In the Cloud console go to **APIs & Services → Library**, search for **Google Analytics Data API**, open it and press **Enable**. Skipping this produces the one error everybody ends up pasting into a search engine: *has not been used in project … before or it is disabled*. If you want Ads as well, enable **Google Ads API** on the same screen.",
            link: { label: "Open the API Library", url: "https://console.cloud.google.com/apis/library" },
          },
          {
            title: "Fill in the consent screen",
            body: "**APIs & Services → OAuth consent screen**. Choose **External** — that is the right answer even for a site only you use. Give it your site's name and your email, and then, on the **Test users** step, add your own Google address. Miss that and Google refuses the connection outright with a message about the app not being verified. You do not need Google to verify anything to use this yourself.",
            link: {
              label: "Open the consent screen",
              url: "https://console.cloud.google.com/apis/credentials/consent",
            },
          },
          {
            title: "Create an OAuth client and paste the Client ID",
            body: "**APIs & Services → Credentials → Create credentials → OAuth client ID**. Application type: **Web application**. Under **Authorised redirect URIs** press **Add URI** and paste the address below — character for character, including https and any trailing path. Save, and Google shows you two values. The first is the Client ID.",
            done: settings.clientId !== "",
            copy: state.redirectUri,
            input: {
              endpoint: set("clientId"),
              value: settings.clientId,
              placeholder: "1234-abcd.apps.googleusercontent.com",
            },
            link: { label: "Open Credentials", url: "https://console.cloud.google.com/apis/credentials" },
          },
          {
            title: "Paste the client secret",
            body: "The other of the two values Google just showed you. It is encrypted before it is stored and never shown again — from here on you only ever see its last four characters.",
            done: settings.clientSecret !== "",
            input: {
              endpoint: set("clientSecret"),
              placeholder: "GOCSPX-…",
              secret: true,
              action: "Save secret",
            },
          },
          {
            title: "Connect your Google account",
            body: live
              ? `Connected as **${state.connected?.account ?? "your Google account"}**. Press again to reconnect if you change which account or which permissions it has.`
              : "This sends you to Google to say yes. Use the account that can see the Analytics property — if that is a different Google account from the one you are signed in as, switch first.",
            done: live,
            connect: {
              endpoint: "/ext/google/connections",
              id: "google",
              label: live ? "Reconnect" : "Connect Google",
            },
          },
          {
            title: "Choose which property to read",
            body: "One Google account can see several websites. This is the one whose numbers show up here. Choosing it also fills in the Measurement ID above, if it is still blank.",
            done: settings.propertyId !== "",
            choices: {
              endpoint: set("propertyId"),
              selected: settings.propertyId || null,
              empty: emptyList(
                state.properties.error,
                "Connect a Google account above and the properties it can see appear here.",
              ),
              options: state.properties.options,
            },
          },
        ],
      },

      {
        title: "Google Ads spend",
        optional: true,
        summary:
          "Ads needs one credential more than Analytics does, and it is the one with a queue in front of it. Worth starting early if you want it, because the waiting is not optional.",
        time: "Twenty minutes of work, then a day or two of waiting on Google.",
        steps: [
          {
            title: "Get a developer token",
            body: "In Google Ads: **Tools → Setup → API Center**. Only a **manager account** can see that screen — if it is not there, make one at ads.google.com under manager accounts and link your advertising account to it. The token appears immediately, but it starts on **Test Account** access, which returns nothing at all for a real account. Apply for **Basic** access on the same screen. Google usually answers within a day or two.",
            done: settings.adsDeveloperToken !== "",
            input: {
              endpoint: set("adsDeveloperToken"),
              placeholder: "your developer token",
              secret: true,
              action: "Save token",
            },
            link: { label: "Open the API Center", url: "https://ads.google.com/aw/apicenter" },
          },
          {
            title: "Reconnect your Google account",
            body: "Inkling only asks Google for permission to read Ads once there is a token to use it with, so the connection you already made does not carry it. Press this and say yes to the extra permission.",
            done: state.adsGranted,
            connect: { endpoint: "/ext/google/connections", id: "google", label: "Reconnect Google" },
          },
          {
            title: "Choose which Ads account",
            body: "Pick the account that runs the ads, not the manager account above it. A manager holds no spend of its own, so choosing one is the reason a correctly configured Ads panel reads zero.",
            done: settings.adsCustomerId !== "",
            choices: {
              endpoint: set("adsCustomerId"),
              selected: settings.adsCustomerId || null,
              empty: emptyList(
                state.adsAccounts.error,
                "Save a developer token and reconnect, and the accounts it can see appear here.",
              ),
              options: state.adsAccounts.options,
            },
          },
        ],
      },
    ],

    gotchas: [
      "The **Measurement ID** (G-ABCD1234) and the **Stream ID** (a long number, right next to it) sit on the same screen and are not interchangeable. The snippet wants the one starting with G-.",
      "An id starting with **UA-** is Universal Analytics, which Google switched off in 2023. It collects nothing. The replacement is under Admin → Data streams.",
      "**Redirect URI mismatch** is the most common failure of the connect step, and it is always literal: a missing https, an extra slash, or the address of a different site. Copy it from this page rather than typing it.",
      "If Google says the app **is not verified** and refuses, your own address is not in the Test users list on the consent screen. Adding it fixes it; verification is for apps other people sign into.",
      "*has not been used in project … before or it is disabled* means the API is off, not that anything is broken. Enable it in the Library and give it a minute.",
      "An Ads developer token on **Test Account** access returns zeros for a real account rather than an error. If everything looks right and the numbers are all zero, that is usually why.",
      "Google Ads retires an API version every few months. When one is turned off, this stops with Google's own message about the version — change it in Google settings and it works again.",
    ],
  }
}
