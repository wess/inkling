import type { Connection } from "atlas/db"
import type { Route } from "atlas/server"
import { badRequest, get, json, parseJson, pipeline, put, putHeader, text } from "atlas/server"
import { auth, requireAuth, requireCan } from "../auth/guard.ts"
import { can } from "../auth/roles.ts"
import { body } from "../http/index.ts"
import type { Hooks } from "../plugins/hooks.ts"
import { createAudit } from "../security/index.ts"
import { readSetting, writeSetting } from "../settings/index.ts"

// Design changes a person can ask Inky for in plain words — "make every button
// black" — without opening a stylesheet.
//
// Inkling is headless, so the markup and the CSS belong to the host site and
// Inkling cannot know what a "button" is. The host says so: it declares
// *surfaces*, named groups of selectors in the vocabulary a client uses. Inky
// only ever picks a surface and a property; it never writes a selector or a
// stylesheet. That is the safety model — the model's whole reach is a
// {surface, property, value} triple, every part of which is checked here
// against something the host or this file enumerated, and a prompt-injected
// "value" has nowhere to go.
//
// Approved rules are stored as data and rendered into one stylesheet the host
// loads after its own. Rules are emitted `!important`, because the override has
// to beat selectors the host wrote with more specificity than a surface's, and
// a design override that silently loses to the stylesheet it overrides is the
// failure nobody can diagnose from the admin.

export type Surface = {
  // As the client would say it: "Buttons", "Page headings".
  readonly label: string
  // CSS selectors this surface covers. Trusted: they come from the host's code.
  readonly selector: string
  // Shown to the model, so it can tell "Buttons" from "Header buttons".
  readonly describes?: string
}

export type Surfaces = Readonly<Record<string, Surface>>

export type Rule = { readonly surface: string; readonly property: string; readonly value: string }

// What a rule may set, and what kind of value each takes. Closed on purpose:
// every property here is one a design tweak plausibly needs and none can load a
// resource, so the value check below is a type check rather than a blocklist.
type Kind = "color" | "length" | "spacing" | "weight" | "opacity" | "keyword" | "shadow"

type Spec = { readonly kind: Kind; readonly help: string; readonly words?: readonly string[] }

export const PROPERTIES: Readonly<Record<string, Spec>> = {
  // `background` rather than `background-color`: a button painted with a
  // gradient ignores a plain colour, and "make it black" has to mean black.
  background: { kind: "color", help: "a solid fill colour; replaces any gradient or image" },
  color: { kind: "color", help: "text colour" },
  "border-color": { kind: "color", help: "border colour" },
  "border-radius": { kind: "length", help: "corner rounding, e.g. 0 for square or 999px for pill" },
  "font-size": { kind: "length", help: "text size, e.g. 18px or 1.1rem" },
  "font-weight": { kind: "weight", help: "100 to 900, normal, or bold" },
  "letter-spacing": { kind: "length", help: "space between letters, e.g. 0.05em" },
  padding: { kind: "spacing", help: "inner space: one to four lengths, e.g. 12px 24px" },
  "text-transform": { kind: "keyword", words: ["none", "uppercase", "lowercase", "capitalize"], help: "letter case" },
  "font-style": { kind: "keyword", words: ["normal", "italic"], help: "italic or not" },
  "text-decoration": { kind: "keyword", words: ["none", "underline"], help: "underline or not" },
  opacity: { kind: "opacity", help: "0 (invisible) to 1" },
  "box-shadow": { kind: "shadow", help: "a shadow like 0 4px 12px rgba(0,0,0,0.2), or none" },
}

const MAX_RULES = 200
const MAX_VALUE = 120

const COLOR_FUNCTION = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\([0-9a-zA-Z.,%/\s+-]{1,80}\)$/
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
// A bare word is a colour name, or nothing: the browser drops one it does not
// know, and an identifier cannot carry a url() or close a declaration.
const NAMED = /^[a-zA-Z]{3,24}$/
const VAR = /^var\(--[\w-]{1,40}\)$/
const LENGTH = /^-?(?:\d{1,4}|\d{0,4}\.\d{1,3})(?:px|rem|em|%|vw|vh|ch)?$/
const SHADOW = /^[\w\s.,#()%/-]{1,100}$/

const isLength = (text: string): boolean =>
  LENGTH.test(text) && (text === "0" || /[a-z%]$/.test(text) || text === "0.0")

// The value as it will be written into the stylesheet, or null when it is not
// acceptable for its property. Null rather than a thrown error: the caller
// decides whether that is a 400 (an apply) or a message back to the model.
export const cleanValue = (property: string, raw: unknown): string | null => {
  const spec = PROPERTIES[property]
  if (!spec || typeof raw !== "string") return null
  const value = raw.trim()
  if (value === "" || value.length > MAX_VALUE) return null

  switch (spec.kind) {
    case "color":
      return HEX.test(value) || COLOR_FUNCTION.test(value) || NAMED.test(value) || VAR.test(value) ? value : null
    case "length":
      return isLength(value) ? value : null
    case "spacing": {
      const parts = value.split(/\s+/)
      return parts.length >= 1 && parts.length <= 4 && parts.every(isLength) ? parts.join(" ") : null
    }
    case "weight":
      return /^(?:[1-9]00|normal|bold)$/.test(value) ? value : null
    case "opacity": {
      const number = Number(value)
      return Number.isFinite(number) && number >= 0 && number <= 1 ? String(number) : null
    }
    case "keyword":
      return (spec.words ?? []).includes(value.toLowerCase()) ? value.toLowerCase() : null
    case "shadow":
      return value === "none" || (SHADOW.test(value) && !/url|expression|import/i.test(value)) ? value : null
  }
}

// What the model is told about each property, in one place with the validator.
export const propertyHelp = (): Record<string, string> =>
  Object.fromEntries(Object.entries(PROPERTIES).map(([name, spec]) => [name, spec.help]))

export type Change = { readonly surface: string; readonly property: string; readonly value: string | null }

// One change checked against the surfaces the host declared. A string is the
// reason it was refused, worded for the model to correct itself with.
export const checkChange = (surfaces: Surfaces, change: Change): string | null => {
  if (!surfaces[change.surface]) {
    return `No design surface called "${change.surface}". Use one of: ${Object.keys(surfaces).join(", ")}.`
  }
  if (!PROPERTIES[change.property]) {
    return `"${change.property}" is not something that can be changed. Use one of: ${Object.keys(PROPERTIES).join(", ")}.`
  }
  if (change.value === null) return null
  if (cleanValue(change.property, change.value) === null) {
    return `"${change.value}" is not a valid ${change.property} (${PROPERTIES[change.property]?.help}).`
  }
  return null
}

// Stored rules are untrusted on the way out, same as theme overrides: a surface
// the host has since removed, or a value that no longer validates, is dropped
// rather than rendered.
export const sanitize = (surfaces: Surfaces, stored: unknown): Rule[] => {
  if (!Array.isArray(stored)) return []
  const seen = new Set<string>()
  const rules: Rule[] = []
  for (const item of stored) {
    if (typeof item !== "object" || item === null) continue
    const { surface, property, value } = item as Record<string, unknown>
    if (typeof surface !== "string" || typeof property !== "string" || !surfaces[surface]) continue
    const clean = cleanValue(property, value)
    const key = `${surface}\u0000${property}`
    if (clean === null || seen.has(key)) continue
    seen.add(key)
    rules.push({ surface, property, value: clean })
    if (rules.length >= MAX_RULES) break
  }
  return rules
}

// A null value clears the rule, which is how "put it back" is expressed.
export const merge = (surfaces: Surfaces, rules: readonly Rule[], changes: readonly Change[]): Rule[] => {
  const next = new Map(rules.map(rule => [`${rule.surface}\u0000${rule.property}`, rule]))
  for (const change of changes) {
    const key = `${change.surface}\u0000${change.property}`
    const clean = change.value === null ? null : cleanValue(change.property, change.value)
    if (clean === null) next.delete(key)
    else next.set(key, { surface: change.surface, property: change.property, value: clean })
  }
  return sanitize(surfaces, [...next.values()])
}

export const designCss = (surfaces: Surfaces, rules: readonly Rule[]): string => {
  const blocks: string[] = []
  for (const [name, surface] of Object.entries(surfaces)) {
    const mine = rules.filter(rule => rule.surface === name)
    if (mine.length === 0) continue
    const lines = mine.map(rule => `  ${rule.property}: ${rule.value} !important;`)
    blocks.push(`/* ${surface.label} */\n${surface.selector} {\n${lines.join("\n")}\n}`)
  }
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`
}

const SCOPE = "design"
const KEY = "rules"

export const readRules = async (db: Connection, surfaces: Surfaces): Promise<Rule[]> =>
  sanitize(surfaces, await readSetting<unknown>(db, SCOPE, KEY, []))

export const readDesignCss = async (db: Connection, surfaces: Surfaces): Promise<string> =>
  designCss(surfaces, await readRules(db, surfaces))

// A short stable digest, so a host can version the stylesheet's URL and a
// browser never holds an old design past the change.
export const designVersion = (css: string): string =>
  new Bun.CryptoHasher("sha1").update(css).digest("hex").slice(0, 10)

export const describeSurfaces = (surfaces: Surfaces) =>
  Object.entries(surfaces).map(([name, surface]) => ({
    name,
    label: surface.label,
    describes: surface.describes ?? null,
  }))

export const designRoutes = (db: Connection, surfaces: Surfaces, hooks?: Hooks): Route[] => {
  const read = pipeline(requireAuth(db), requireCan(can.readContent, "read content"))
  const write = pipeline(requireAuth(db), requireCan(can.manageSettings, "change the design"), parseJson)
  const audit = createAudit(db)

  return [
    get(
      "/design",
      read(async c =>
        json(c, 200, {
          surfaces: describeSurfaces(surfaces),
          properties: propertyHelp(),
          rules: await readRules(db, surfaces),
        }),
      ),
    ),

    put(
      "/design",
      write(async c => {
        const input = body(c)
        const changes = Array.isArray(input.changes) ? (input.changes as Change[]) : []
        if (changes.length === 0) throw badRequest("Send the changes to make", { code: "NO_CHANGES" })
        if (changes.length > 50) throw badRequest("Too many changes at once", { code: "TOO_MANY" })

        for (const change of changes) {
          const problem = checkChange(surfaces, {
            surface: String(change?.surface),
            property: String(change?.property),
            value: change?.value === null ? null : (change?.value as string),
          })
          if (problem) throw badRequest(problem, { code: "BAD_DESIGN" })
        }

        const before = await readRules(db, surfaces)
        const after = merge(surfaces, before, changes)
        await writeSetting(db, SCOPE, KEY, after)
        audit.log({
          userId: auth(c).id,
          event: "design.updated",
          metadata: { changes, before },
        })
        await hooks?.emit("design.afterSave", {})
        return json(c, 200, { rules: after })
      }),
    ),
  ]
}

// Public, and deliberately without a delivery key: it is fetched by a <link>
// tag, which cannot send one. It exposes only the stylesheet the visitor's
// browser is about to apply anyway. `no-cache` rather than a max-age: the point
// of the feature is that an approved change is on the page at the next load, and
// the ETag makes the revalidation a 304 when nothing moved.
export const designPublicRoutes = (db: Connection, surfaces: Surfaces): Route[] => [
  get("/site/design.css", async c => {
    const css = await readDesignCss(db, surfaces)
    const tag = `"${designVersion(css)}"`
    const fresh = c.request.headers.get("if-none-match") === tag
    const response = fresh ? text(c, 304, "") : text(c, 200, css)
    const typed = putHeader(response, "content-type", "text/css; charset=utf-8")
    return putHeader(putHeader(typed, "cache-control", "public, no-cache"), "etag", tag)
  }),
]
