import type { Conn, PipeFn, Route } from "atlas/server"
import { badRequest, halt, pipe, putHeader } from "atlas/server"
import { config } from "../config/index.ts"

// Mounts a feature's routes under a base path. Every session-gated route lives
// under /api so the rest of the origin is free for the admin's own URLs —
// otherwise `/settings` would be ambiguous between the API and the screen, and
// six other paths with it.
//
// The same shape the plugin registry uses to namespace /ext/<name>.
export const prefixed = (base: string, routes: readonly Route[]): Route[] =>
  routes.map(route => ({ ...route, pattern: `${base}${route.pattern === "/" ? "" : route.pattern}` }))

// Bodies arriving as JSON are parsed by `parseJson`, but handlers still need a
// safe object to destructure from — an absent or non-object body should read as
// "no fields supplied", not crash.
export const body = (c: Conn): Record<string, unknown> =>
  typeof c.body === "object" && c.body !== null && !Array.isArray(c.body) ? (c.body as Record<string, unknown>) : {}

export const text = (source: Record<string, unknown>, key: string, fallback = ""): string => {
  const value = source[key]
  return typeof value === "string" ? value : fallback
}

export const requireText = (source: Record<string, unknown>, key: string, label = key): string => {
  const value = source[key]
  if (typeof value !== "string" || value.trim() === "") throw badRequest(`${label} is required`, { code: "MISSING" })
  return value.trim()
}

export const optionalText = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key]
  if (value === null) return null
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null
}

export const bool = (source: Record<string, unknown>, key: string, fallback = false): boolean => {
  const value = source[key]
  if (value === undefined) return fallback
  return value === true || value === 1 || value === "true" || value === "1"
}

// Query params and JSON keys are accepted in both snake_case and camelCase so a
// consumer can use whichever reads naturally in their language.
export const either = (source: Record<string, unknown>, snake: string, camel: string): unknown =>
  source[snake] !== undefined ? source[snake] : source[camel]

const ORIGINS = config.deliveryOrigins

// The delivery API is read-only and key-authenticated, so CORS here only needs
// to unblock browsers that legitimately hold a key. An empty allowlist means
// server-to-server only, which is the recommended posture.
export const corsFor = (methods: readonly string[], origins: readonly string[] = ORIGINS): PipeFn =>
  pipe((c: Conn) => {
    const origin = c.headers.get("origin")
    if (!origin) return c

    const allowed = origins.includes("*") ? origin : origins.includes(origin) ? origin : null
    if (!allowed) return c

    return putHeader(
      putHeader(
        putHeader(
          putHeader(c, "access-control-allow-origin", allowed),
          "access-control-allow-headers",
          "authorization,content-type,x-api-key",
        ),
        "access-control-allow-methods",
        methods.join(","),
      ),
      "vary",
      "origin",
    )
  })

export const cors: PipeFn = corsFor(["GET", "OPTIONS"])
export const corsAll: PipeFn = corsFor(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])

export const preflight = (c: Conn) => halt(c, 204)

export const noStore = (c: Conn): Conn => putHeader(c, "cache-control", "no-store")
