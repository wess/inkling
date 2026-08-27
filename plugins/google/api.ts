// The two Google APIs this plugin reads, and the one habit worth having with
// both: hand back Google's own words when something is refused.
//
// Every failure here is a configuration mistake somewhere else — an API not
// switched on, a property the account cannot see, a developer token still
// pending approval — and Google says which, precisely, in the response body.
// Replacing that with "could not load analytics" throws away the only sentence
// that would have told somebody what to go and fix.

export class GoogleError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = "GoogleError"
  }
}

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const text = await response.text()
  if (!response.ok) throw new GoogleError(response.status, explain(response.status, text))
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new GoogleError(response.status, "Google's reply was not JSON, which usually means a sign-in page.")
  }
}

// Google nests the useful sentence two or three levels down, and puts a second,
// less useful one at the top. This digs out the deepest `message` it can find.
export const detail = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = (parsed.error ?? parsed) as Record<string, unknown>
    const nested = Array.isArray(error.details) ? (error.details as Record<string, unknown>[]) : []
    const deepest = nested
      .flatMap(item => (Array.isArray(item.errors) ? (item.errors as Record<string, unknown>[]) : []))
      .map(item => (typeof item.message === "string" ? item.message : ""))
      .filter(Boolean)
    if (deepest.length > 0) return deepest.join(" ")
    if (typeof error.message === "string") return error.message
    if (typeof error.error_description === "string") return error.error_description
  } catch {
    // Not JSON. The raw body is still the most informative thing available.
  }
  return body.slice(0, 300)
}

// Three statuses mean something specific enough to be worth translating, since
// Google's own wording for them assumes you know which console you are in.
const explain = (status: number, body: string): string => {
  const said = detail(body)
  if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(said)) {
    return `${said} — switch it on in the Google Cloud console under APIs & Services → Library, then try again in a minute.`
  }
  if (status === 403 && /permission|PERMISSION_DENIED/i.test(said)) {
    return `${said} — the connected Google account cannot see that property or account. Connect the one that can, or have it granted access.`
  }
  if (status === 401) return `${said || "Google rejected the access token"} — press Reconnect on the Google account.`
  return said || `Google returned ${status}`
}

export const getJson = async (url: string, token: string, headers: Record<string, string> = {}) =>
  readJson(await fetch(url, { headers: { ...headers, authorization: `Bearer ${token}`, accept: "application/json" } }))

export const postJson = async (
  url: string,
  token: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> =>
  readJson(
    await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    }),
  )

// searchStream answers with a JSON *array* of chunks rather than one object,
// which is the only place in either API where that is true.
export const postStream = async (
  url: string,
  token: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<Record<string, unknown>[]> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  })

  const text = await response.text()
  if (!response.ok) throw new GoogleError(response.status, explain(response.status, text))

  try {
    const parsed = JSON.parse(text) as unknown
    const chunks = Array.isArray(parsed) ? parsed : [parsed]
    return chunks.flatMap(chunk => {
      const results = (chunk as Record<string, unknown>).results
      return Array.isArray(results) ? (results as Record<string, unknown>[]) : []
    })
  } catch {
    throw new GoogleError(response.status, "Google Ads returned something that was not JSON.")
  }
}
