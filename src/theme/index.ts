import type { FontFamily, Palette, Template, ThemeToken } from "../../templates/registry.ts"

// Theme tokens in, CSS out.
//
// The entire contract between a template and the markup that consumes it is a
// set of custom properties on :root. A section never reads a token by name in
// code — it writes `var(--accent)` in its own CSS — which is what lets an
// operator change the look without a template being able to run anything.
//
// Everything here is a pure function of the manifest and the operator's saved
// overrides. It touches no database and no network: the caller reads settings,
// this turns them into a stylesheet, and the result is cacheable on the pair.

export type ThemeValues = Readonly<Record<string, string | number>>

// A token's value can reach here from a settings row, where it was stored as
// whatever JSON the editor produced. Anything that is not a string or a finite
// number is not a CSS value, and falling back to the template's own default is
// better than emitting `--accent: [object Object]` and rendering a blank page.
const usable = (value: unknown): value is string | number =>
  (typeof value === "string" && value.trim() !== "") || (typeof value === "number" && Number.isFinite(value))

export const propertyName = (token: ThemeToken): string => `--${token.css ?? token.key}`

// The first palette is the default, which is also what the colour tokens
// declare — the registry refuses a template where those two disagree.
export const paletteOf = (template: Template, id?: string): Palette | undefined =>
  id ? template.palettes.find(palette => palette.id === id) : template.palettes[0]

// Three layers, innermost first: the token's own default, the chosen palette,
// then whatever the operator changed by hand. A palette is a starting point, so
// picking one must not silently discard a colour someone deliberately set — and
// equally, a hand-set colour must not survive a palette change it contradicts.
// Overrides win, because the alternative is a colour the operator cannot clear.
export const resolveValues = (template: Template, overrides: ThemeValues = {}, paletteId?: string): ThemeValues => {
  const palette = paletteOf(template, paletteId)
  return palette ? { ...palette.colors, ...overrides } : overrides
}

export const tokensOf = (template: Template): readonly ThemeToken[] => template.theme.flatMap(group => group.tokens)

// The value a token resolves to, before its unit is attached. Not `valueOf`:
// that shadows the one on Object.prototype, which every object in the program
// inherits.
export const tokenValue = (token: ThemeToken, overrides: ThemeValues): string | number => {
  const override = overrides[token.key]
  return usable(override) ? override : token.default
}

// A stored value reaches a stylesheet served to every visitor, so it is
// untrusted on the way out even though nothing in the admin offers to abuse it.
//
// The defence is the token's own type rather than a blocklist of characters.
// Stripping `;` and `}` does stop a value closing its declaration, but it
// leaves everything else through — `url(https://…)` in a token used for a
// background is an outbound request on every page load, and no amount of
// character removal makes that safe. A colour that must match a colour pattern
// cannot be a URL at all.
//
// Anything that fails its type falls back to the template's default, because a
// theme rendering in its designed colours is a better failure than a blank page.

const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^(?:rgb|hsl)a?\([0-9a-zA-Z.,%/\s+-]+\)$/
// Free-form text is the only token that is not enumerable, so it keeps a
// blocklist — and `url(` is on it for the reason above.
const TEXT_UNSAFE = /[<>{};]|\/\*|\*\/|url\s*\(|expression\s*\(|@import/i

const fallback = (token: ThemeToken): string =>
  typeof token.default === "number" && token.unit ? `${token.default}${token.unit}` : String(token.default)

const safeValue = (token: ThemeToken, resolved: string | number, families: ReadonlySet<string>): string => {
  switch (token.type) {
    case "color":
      return COLOR.test(String(resolved).trim()) ? String(resolved).trim() : fallback(token)
    case "number": {
      const parsed = typeof resolved === "number" ? resolved : Number(resolved)
      if (!Number.isFinite(parsed)) return fallback(token)
      return token.unit ? `${parsed}${token.unit}` : String(parsed)
    }
    case "select":
      return (token.options ?? []).some(option => option.value === resolved) ? String(resolved) : fallback(token)
    case "font":
      return families.has(String(resolved)) ? String(resolved) : fallback(token)
    default: {
      const text = String(resolved).trim()
      return text === "" || TEXT_UNSAFE.test(text) ? fallback(token) : text
    }
  }
}

const declaration = (token: ThemeToken, overrides: ThemeValues, families: ReadonlySet<string>): string =>
  `  ${propertyName(token)}: ${safeValue(token, tokenValue(token, overrides), families)};`

export const themeCss = (template: Template, overrides: ThemeValues = {}, paletteId?: string): string => {
  const families = new Set(template.fonts.map(font => font.family))
  const values = resolveValues(template, overrides, paletteId)
  const lines = template.theme.flatMap(group => [
    `  /* ${group.label} */`,
    ...group.tokens.map(token => declaration(token, values, families)),
  ])
  return `:root {\n${lines.join("\n")}\n}\n`
}

// One stylesheet link for every family the template declares. Built from the
// manifest rather than from the saved values, because a font token may only
// name a declared family — so the set is known ahead of any operator input.
export const fontHref = (fonts: readonly FontFamily[]): string | null => {
  if (fonts.length === 0) return null
  const families = fonts.map(font => {
    const weights = [...new Set(font.weights)].sort((a, b) => a - b)
    const axis = font.italic
      ? `:ital,wght@${weights.map(w => `0,${w}`).join(";")};${weights.map(w => `1,${w}`).join(";")}`
      : `:wght@${weights.join(";")}`
    return `family=${font.family.replace(/ /g, "+")}${axis}`
  })
  return `https://fonts.googleapis.com/css2?${families.join("&")}&display=swap`
}

// Families resolve to their declared stack, so `--fontDisplay` is a usable
// font-family value rather than a bare name that dies if the webfont does.
export const fontStacks = (template: Template, overrides: ThemeValues = {}): string => {
  const byFamily = new Map(template.fonts.map(font => [font.family, font.stack]))
  const lines = tokensOf(template)
    .filter(token => token.type === "font")
    .map(token => {
      // The family is only ever used as a key into the manifest, so an
      // override naming something undeclared resolves to the default's stack
      // rather than reaching the stylesheet.
      const family = String(tokenValue(token, overrides))
      const stack = byFamily.get(family) ?? byFamily.get(String(token.default)) ?? String(token.default)
      return `  ${propertyName(token)}: ${stack};`
    })
  return lines.length > 0 ? `:root {\n${lines.join("\n")}\n}\n` : ""
}

// What a rendered page needs in its head: the font link and the two blocks.
// Font stacks come last so a `font` token's stack wins over the bare family
// name the token block already emitted for it.
export const stylesheet = (template: Template, overrides: ThemeValues = {}, paletteId?: string): string =>
  `${themeCss(template, overrides, paletteId)}${fontStacks(template, overrides)}`

// The tokens a template exposes, flattened into the shape the settings editor
// already renders — so theming reuses that screen rather than growing its own.
export const themeFields = (template: Template) =>
  tokensOf(template).map(token => ({
    key: token.key,
    label: token.label,
    type: token.type === "font" ? ("select" as const) : (token.type as "color" | "text" | "number" | "select"),
    help: token.help,
    default: token.default,
    options:
      token.type === "font" ? template.fonts.map(font => ({ value: font.family, label: font.family })) : token.options,
  }))
