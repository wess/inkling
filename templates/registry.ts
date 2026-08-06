import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import type { Field } from "../src/fields/index.ts"

// The template registry. One directory per template, one `template.json` in
// each, validated on the way in.
//
// This is a directory today and it is shaped like a registry anyway — a
// manifest per template, a loader that validates against a schema, and no
// import of anything outside `src/fields` for its types. A template eventually
// arrives from somewhere other than this repository, and discovering that shape
// afterwards would mean rewriting every template that already exists.
//
// Nothing here executes template code. A manifest is data, it is checked as
// data, and the render pipeline that will consume it is deliberately not able
// to run anything a manifest names. See docs/TEMPLATES.md.

// A token resolves to exactly one CSS value, which is why this is a subset of
// FieldType rather than all of it. Anything that cannot be a single value —
// an image, a reference, a repeater — is a section field, not a theme token.
export type ThemeTokenType = "color" | "text" | "number" | "select" | "font"

export type ThemeToken = {
  readonly key: string
  readonly label: string
  readonly type: ThemeTokenType
  readonly default: string | number
  readonly help?: string
  readonly options?: readonly { value: string; label: string }[]
  // Appended to the compiled value: "px", "rem", "ms". Kept out of the default
  // so the settings editor can show a number input rather than a string.
  readonly unit?: string
  // Overrides the derived `--<key>` custom property name. Rare, and only for a
  // token whose natural CSS name differs from its editor name.
  readonly css?: string
}

export type ThemeGroup = {
  readonly id: string
  readonly label: string
  readonly tokens: readonly ThemeToken[]
}

// Every family a template may name, with the weights it actually uses. The
// compiler builds one stylesheet link from this, and a token of type `font` may
// only name a family declared here — which is what stops a template from
// becoming an arbitrary outbound request.
export type FontFamily = {
  readonly family: string
  readonly weights: readonly number[]
  readonly italic?: boolean
  // The CSS stack this family falls back through, so a blocked or slow webfont
  // degrades to something chosen rather than to Times.
  readonly stack: string
}

// Structure, not colour. Two templates with different palettes and the same
// layout are one template twice — these are the choices that make a design
// recognisably a different design, and they are a closed set because a
// marketplace template must not be able to ship arbitrary markup.
export type NavLayout = "bar" | "stacked" | "rail"
export type HeroLayout = "stack" | "split" | "banner" | "editorial"
export type CardStyle = "bordered" | "filled" | "plain" | "raised"
export type Alignment = "left" | "center"
export type Rhythm = "tight" | "normal" | "airy"

export type TemplateLayout = {
  readonly nav: NavLayout
  readonly hero: HeroLayout
  readonly cards: CardStyle
  readonly align: Alignment
  readonly rhythm: Rhythm
}

export const NAV_LAYOUTS: readonly NavLayout[] = ["bar", "stacked", "rail"]
export const HERO_LAYOUTS: readonly HeroLayout[] = ["stack", "split", "banner", "editorial"]
export const CARD_STYLES: readonly CardStyle[] = ["bordered", "filled", "plain", "raised"]
export const ALIGNMENTS: readonly Alignment[] = ["left", "center"]
export const RHYTHMS: readonly Rhythm[] = ["tight", "normal", "airy"]

// A design carries several palettes, the way a Squarespace family does. The
// colour *tokens* stay the single source of truth for which colours exist; a
// palette only supplies an alternative set of values for them, and is validated
// against them so a palette can never be missing one or invent a new one.
export type Palette = {
  readonly id: string
  readonly label: string
  // Keyed by colour token. Every colour token must appear.
  readonly colors: Readonly<Record<string, string>>
  // For a palette whose background is darker than its text, so a renderer can
  // set color-scheme and pick the right favicon or map style without guessing.
  readonly dark?: boolean
}

export type TemplateSection = {
  readonly name: string
  readonly label: string
  readonly description?: string
  readonly fields: readonly Field[]
}

export type TemplateContentType = {
  readonly name: string
  readonly label: string
  readonly pluralLabel?: string
  readonly description?: string
  readonly kind?: "collection" | "single"
  readonly icon?: string
  readonly fields: readonly Field[]
}

export type Template = {
  readonly name: string
  readonly label: string
  readonly description: string
  readonly version: string
  readonly author?: string
  // One sentence on who this is for. Templates are chosen by fit, not by
  // feature list, and a person picking one is asking "is this for me".
  readonly suits: string
  readonly layout: TemplateLayout
  readonly fonts: readonly FontFamily[]
  // The first is the default, and its values must match the colour tokens'
  // own defaults — one design, several moods.
  readonly palettes: readonly Palette[]
  readonly theme: readonly ThemeGroup[]
  readonly contentTypes: readonly TemplateContentType[]
  readonly sections: readonly TemplateSection[]
}

const NAME = /^[a-z][a-z0-9]*$/
const KEY = /^[a-z][a-zA-Z0-9]*$/
const TOKEN_TYPES = new Set<string>(["color", "text", "number", "select", "font"])
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export type Invalid = { readonly ok: false; readonly error: string }
export type Valid = { readonly ok: true; readonly template: Template }

const fail = (error: string): Invalid => ({ ok: false, error })

const validateToken = (token: ThemeToken, group: string, families: Set<string>): string | null => {
  if (typeof token.key !== "string" || !KEY.test(token.key)) {
    return `token key "${token.key}" in group "${group}" must be camelCase starting with a letter`
  }
  if (!TOKEN_TYPES.has(token.type)) {
    return `token "${token.key}" has type "${token.type}", which is not one of ${[...TOKEN_TYPES].join(", ")}`
  }
  if (token.default === undefined || token.default === null || token.default === "") {
    // A token with no default renders as an empty custom property, which is a
    // blank page rather than an error. Requiring one here is what keeps a
    // half-filled manifest from being discovered visually.
    return `token "${token.key}" needs a default`
  }
  if (token.type === "number" && typeof token.default !== "number") {
    return `token "${token.key}" is a number and its default must be one`
  }
  if (token.type === "color" && !HEX.test(String(token.default))) {
    return `token "${token.key}" is a color and its default must be a hex value, got "${token.default}"`
  }
  if (token.type === "select") {
    const options = token.options ?? []
    if (options.length === 0) return `token "${token.key}" is a select and needs options`
    if (!options.some(option => option.value === token.default)) {
      return `token "${token.key}" defaults to "${token.default}", which is not one of its options`
    }
  }
  if (token.type === "font" && !families.has(String(token.default))) {
    return `token "${token.key}" names the family "${token.default}", which the template does not declare in "fonts"`
  }
  return null
}

export const validateTemplate = (value: unknown): Valid | Invalid => {
  if (typeof value !== "object" || value === null) return fail("manifest is not an object")
  const t = value as Partial<Template>

  if (typeof t.name !== "string" || !NAME.test(t.name)) {
    return fail(`name "${t.name}" must be lowercase letters and digits, starting with a letter`)
  }
  for (const key of ["label", "description", "version", "suits"] as const) {
    if (typeof t[key] !== "string" || t[key]?.trim() === "") return fail(`"${t.name}" is missing ${key}`)
  }

  const layout = t.layout
  if (typeof layout !== "object" || layout === null) return fail(`"${t.name}" declares no layout`)
  for (const [key, allowed] of [
    ["nav", NAV_LAYOUTS],
    ["hero", HERO_LAYOUTS],
    ["cards", CARD_STYLES],
    ["align", ALIGNMENTS],
    ["rhythm", RHYTHMS],
  ] as const) {
    const value = (layout as Record<string, unknown>)[key]
    if (!(allowed as readonly string[]).includes(String(value))) {
      return fail(`"${t.name}" has layout.${key} = "${value}", which is not one of ${allowed.join(", ")}`)
    }
  }

  if (!Array.isArray(t.fonts) || t.fonts.length === 0) return fail(`"${t.name}" declares no fonts`)
  const families = new Set<string>()
  for (const font of t.fonts) {
    if (typeof font.family !== "string" || font.family.trim() === "") return fail(`"${t.name}" has a font with no family`)
    if (!Array.isArray(font.weights) || font.weights.length === 0) {
      return fail(`"${t.name}" declares "${font.family}" with no weights`)
    }
    if (typeof font.stack !== "string" || !font.stack.includes(",")) {
      // One family and no fallback means a blocked webfont lands on the
      // browser default, which is never what the template was designed against.
      return fail(`"${t.name}" declares "${font.family}" without a fallback stack`)
    }
    families.add(font.family)
  }

  if (!Array.isArray(t.theme) || t.theme.length === 0) return fail(`"${t.name}" declares no theme tokens`)
  const seen = new Set<string>()
  for (const group of t.theme) {
    if (typeof group.id !== "string" || !KEY.test(group.id)) return fail(`"${t.name}" has a group with a bad id`)
    if (!Array.isArray(group.tokens) || group.tokens.length === 0) {
      return fail(`"${t.name}" group "${group.id}" has no tokens`)
    }
    for (const token of group.tokens) {
      const error = validateToken(token, group.id, families)
      if (error) return fail(`"${t.name}": ${error}`)
      // Tokens share one CSS namespace across every group, so a duplicate key
      // silently wins or loses depending on group order.
      const css = token.css ?? token.key
      if (seen.has(css)) return fail(`"${t.name}" declares the token "${css}" twice`)
      seen.add(css)
    }
  }

  // Palettes are checked against the colour tokens rather than against a list
  // of their own, so adding a colour token to a template fails every palette
  // that has not been updated instead of rendering one as an empty value.
  const colorKeys = (t.theme ?? []).flatMap(group =>
    group.tokens.filter((token: ThemeToken) => token.type === "color").map((token: ThemeToken) => token.key),
  )
  if (!Array.isArray(t.palettes) || t.palettes.length === 0) return fail(`"${t.name}" declares no palettes`)
  const paletteIds = new Set<string>()
  for (const palette of t.palettes) {
    if (typeof palette.id !== "string" || !KEY.test(palette.id)) {
      return fail(`"${t.name}" has a palette with a bad id: "${palette.id}"`)
    }
    if (paletteIds.has(palette.id)) return fail(`"${t.name}" declares the palette "${palette.id}" twice`)
    paletteIds.add(palette.id)
    if (typeof palette.label !== "string" || palette.label.trim() === "") {
      return fail(`"${t.name}" palette "${palette.id}" has no label`)
    }
    const colors = palette.colors ?? {}
    for (const key of colorKeys) {
      const value = colors[key]
      if (typeof value !== "string" || !HEX.test(value)) {
        return fail(`"${t.name}" palette "${palette.id}" is missing a hex value for "${key}"`)
      }
    }
    for (const key of Object.keys(colors)) {
      if (!colorKeys.includes(key)) {
        return fail(`"${t.name}" palette "${palette.id}" sets "${key}", which is not a colour token`)
      }
    }
  }
  // The default palette is the one the tokens already describe. If they drift,
  // a fresh install and the palette picker disagree about what "default" means.
  const first = t.palettes[0]
  if (first) {
    for (const group of t.theme ?? []) {
      for (const token of group.tokens) {
        if (token.type !== "color") continue
        if (first.colors[token.key] !== token.default) {
          return fail(
            `"${t.name}" token "${token.key}" defaults to "${token.default}" but its first palette ` +
              `("${first.id}") says "${first.colors[token.key]}" — the first palette is the default`,
          )
        }
      }
    }
  }

  if (!Array.isArray(t.contentTypes) || t.contentTypes.length === 0) {
    return fail(`"${t.name}" declares no content types, so it has nothing to render`)
  }
  if (!Array.isArray(t.sections)) return fail(`"${t.name}" is missing sections`)

  return { ok: true, template: t as Template }
}

export const TEMPLATES_DIR = resolve(dirname(), ".")

function dirname(): string {
  return new URL(".", import.meta.url).pathname
}

export type Loaded = { readonly name: string; readonly template?: Template; readonly error?: string }

// Every template in the registry, valid or not. A broken manifest is reported
// rather than thrown, for the same reason a broken plugin is: one bad template
// must not make the other four unreachable.
export const loadTemplates = async (dir: string = TEMPLATES_DIR): Promise<Loaded[]> => {
  const root = resolve(dir)
  if (!existsSync(root)) return []

  const names = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => existsSync(`${root}/${name}/template.json`))
    .sort()

  const loaded: Loaded[] = []
  for (const name of names) {
    try {
      const parsed = await Bun.file(`${root}/${name}/template.json`).json()
      const checked = validateTemplate(parsed)
      if (!checked.ok) {
        loaded.push({ name, error: checked.error })
        continue
      }
      if (checked.template.name !== name) {
        loaded.push({ name, error: `declares name "${checked.template.name}" but lives in directory "${name}"` })
        continue
      }
      loaded.push({ name, template: checked.template })
    } catch (error) {
      loaded.push({ name, error: (error as Error).message })
    }
  }
  return loaded
}

export const loadTemplate = async (name: string, dir: string = TEMPLATES_DIR): Promise<Template | null> => {
  const found = (await loadTemplates(dir)).find(entry => entry.name === name)
  return found?.template ?? null
}
