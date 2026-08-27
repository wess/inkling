import { config } from "../../src/config/index.ts"
import type { OAuthClient } from "../../src/oauth/index.ts"

// What this install has been told about Google, and what that adds up to.
//
// The plugin has two halves that are worth keeping apart in your head, because
// they cost wildly different amounts of somebody's afternoon:
//
//   Measuring   — paste a Measurement ID. Two minutes, no Google Cloud, no
//                 consent screen. The site is measured and the numbers show up
//                 in Google's own reports, which is where most people read them.
//   Reporting   — connect a Google account so those numbers appear *here*, and
//                 so Ads spend does too. This one needs a Cloud project, two
//                 APIs switched on, and a consent screen — an hour, honestly.
//
// Everything downstream asks this file which of those is true, and no screen
// ever presents the second as a prerequisite for the first.

export type Settings = {
  readonly measurementId: string
  readonly containerId: string
  readonly adsConversionId: string
  readonly clientId: string
  readonly clientSecret: string
  readonly propertyId: string
  readonly adsCustomerId: string
  readonly adsLoginCustomerId: string
  readonly adsDeveloperToken: string
  readonly adsApiVersion: string
}

export type Ctx = {
  readonly getSetting: <T>(key: string, fallback: T) => Promise<T>
  readonly setSetting: (key: string, value: unknown) => Promise<void>
}

const environment = (name: string): string => (typeof Bun !== "undefined" ? Bun.env[name] : process.env[name]) ?? ""

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

export const ADS_API_VERSION = "v21"

export const SETTING_KEYS = [
  "measurementId",
  "containerId",
  "adsConversionId",
  "clientId",
  "clientSecret",
  "propertyId",
  "adsCustomerId",
  "adsLoginCustomerId",
  "adsDeveloperToken",
  "adsApiVersion",
] as const

export const settings = async (ctx: Ctx): Promise<Settings> => {
  const read = (key: (typeof SETTING_KEYS)[number]): Promise<string> =>
    ctx.getSetting<string>(key, "").then(value => text(value))

  const [
    measurementId,
    containerId,
    adsConversionId,
    clientId,
    clientSecret,
    propertyId,
    adsCustomerId,
    adsLoginCustomerId,
    adsDeveloperToken,
    adsApiVersion,
  ] = await Promise.all(SETTING_KEYS.map(read))

  return {
    measurementId: measurementId.toUpperCase(),
    containerId: containerId.toUpperCase(),
    adsConversionId: adsConversionId.toUpperCase(),
    // Credentials fall back to the environment, so an install configured before
    // there was a screen keeps working and can be moved into the admin one
    // field at a time by saving over it.
    clientId: clientId || environment("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: clientSecret || environment("GOOGLE_OAUTH_CLIENT_SECRET"),
    propertyId: digits(propertyId),
    adsCustomerId: digits(adsCustomerId),
    adsLoginCustomerId: digits(adsLoginCustomerId),
    adsDeveloperToken: adsDeveloperToken || environment("GOOGLE_ADS_DEVELOPER_TOKEN"),
    adsApiVersion: adsApiVersion || ADS_API_VERSION,
  }
}

// Google prints customer ids as 123-456-7890 and accepts them as 1234567890.
// Property ids arrive pasted as "properties/123456" about half the time. Both
// are reduced to what the API wants rather than validated and rejected, because
// being told "that is not a valid id" about a value you copied off Google's own
// screen is the kind of thing that ends an afternoon.
export const digits = (value: string): string => value.replace(/\D/g, "")

export const SCOPE_ANALYTICS = "https://www.googleapis.com/auth/analytics.readonly"
export const SCOPE_ADS = "https://www.googleapis.com/auth/adwords"

// Ads is only asked for when there is a developer token to use it with. An
// unused permission on a consent screen is one more thing to be uneasy about,
// and Google's own verification review asks why it is there.
export const scopesFor = (current: Settings): string[] => [
  "openid",
  "email",
  SCOPE_ANALYTICS,
  ...(current.adsDeveloperToken ? [SCOPE_ADS] : []),
]

export const redirectUri = (): string => `${config.publicUrl.replace(/\/$/, "")}/ext/google/callback`

export const clientFor = (current: Settings): OAuthClient | null => {
  if (!current.clientId || !current.clientSecret) return null
  return {
    clientId: current.clientId,
    clientSecret: current.clientSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: scopesFor(current),
    // Google documents the credentials in the POST body. Sending them in both
    // places is two authentication methods on one request, which RFC 6749
    // forbids and which Google has been known to reject.
    basicAuth: false,
  }
}

// Without both of these Google issues an access token that dies in an hour and
// no refresh token, so the first report after lunch fails and the fix is a
// reconnect nobody can be expected to guess at. `prompt=consent` is what makes
// Google reissue the refresh token on a *second* authorization of the same app.
export const CONSENT_EXTRA = { access_type: "offline", prompt: "consent", include_granted_scopes: "true" }
