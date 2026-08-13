import type { AccountRow } from "../accounts.ts"
import type { Attachment } from "../media.ts"

// The contract every network implements, and the small amount of HTTP they all
// need. A publisher gets a ready caption, resolved media, and a live token, and
// returns where the post landed — or throws with the network's own words.
//
// Throwing is the interface for failure on purpose. Every one of these fails
// for reasons only the network can explain ("the video is 63 minutes and the
// limit is 15"), the operator has to read that text to act on it, and a
// summary of ours would be strictly worse. `src/social/publish.ts` catches and
// records it against the target.

export type PublishContext = {
  readonly account: AccountRow
  readonly token: string
  readonly caption: string
  readonly link: string | null
  readonly media: readonly Attachment[]
  readonly options: Record<string, unknown>
  // The post's internal title. Networks that insist on one of their own
  // (YouTube) fall back to it before falling back to the caption.
  readonly title: string
}

export type Published = { readonly remoteId: string; readonly url: string | null }

export type Publisher = (context: PublishContext) => Promise<Published>

export const option = (options: Record<string, unknown>, key: string, fallback = ""): string => {
  const value = options[key]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback
}

export const flagged = (options: Record<string, unknown>, key: string): boolean => options[key] === true

// ------------------------------------------------------------------- http

export type Json = Record<string, unknown>

const truncate = (value: string): string => (value.length > 400 ? `${value.slice(0, 400)}…` : value)

// Networks bury the actionable sentence at a different depth each: Graph in
// `error.message`, TikTok in `error.message` beside an `error.code` that is
// "ok" on success, Google in `error.message` inside `error`, X in an array of
// `errors[].detail` or a bare `detail`. Reading all four shapes here is what
// makes a failed post say why rather than say 400.
export const messageIn = (payload: Json, status: number): string => {
  const error = payload.error
  if (typeof error === "string" && error.trim()) return truncate(error)

  if (error !== null && typeof error === "object") {
    const detail = error as Json
    const message = detail.message ?? detail.error_description ?? detail.description
    if (typeof message === "string" && message.trim()) return truncate(message)
  }

  const errors = payload.errors
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as Json
    const message = first?.detail ?? first?.message ?? first?.title
    if (typeof message === "string" && message.trim()) return truncate(message)
  }

  for (const key of ["detail", "message", "error_description", "title"]) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) return truncate(value)
  }

  return `The network refused the request (${status})`
}

export const readJson = async (response: Response): Promise<Json> => {
  const text = await response.text()
  let payload: Json = {}
  try {
    payload = text ? (JSON.parse(text) as Json) : {}
  } catch {
    if (!response.ok) throw new Error(`${response.status}: ${truncate(text)}`)
    throw new Error("The network's reply was not JSON")
  }
  if (!response.ok) throw new Error(messageIn(payload, response.status))
  return payload
}

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

export const str = (source: Json | undefined, key: string): string | null => {
  const value = source?.[key]
  if (typeof value === "string" && value.trim() !== "") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

export const nested = (source: Json | undefined, key: string): Json | undefined => {
  const value = source?.[key]
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined
}

// Several of these networks accept an upload and then process it out of band,
// which means "posted" is a poll rather than a response. Bounded so a stuck
// encode fails the target instead of holding the sweep open forever — the next
// tick will not retry a target already marked failed, and the operator sees the
// network's own last word about it.
export const pollUntil = async <T>(
  attempt: () => Promise<T | null>,
  { tries = 20, waitMs = 3000 }: { tries?: number; waitMs?: number } = {},
): Promise<T> => {
  let last: unknown = null
  for (let index = 0; index < tries; index += 1) {
    try {
      const result = await attempt()
      if (result !== null) return result
    } catch (error) {
      last = error
    }
    await new Promise(resolve => setTimeout(resolve, waitMs))
  }
  throw last instanceof Error
    ? last
    : new Error("The network accepted the upload but never finished processing it. Check the account directly.")
}
