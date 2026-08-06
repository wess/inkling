import { expect, test } from "bun:test"
import { fontHref, propertyName, stylesheet, themeCss, themeFields, tokensOf } from "../src/theme/index.ts"
import type { Template } from "../templates/registry.ts"
import { loadTemplates, validateTemplate } from "../templates/registry.ts"

// The registry is data, so these are mostly checks that a bad manifest is caught
// on the way in rather than discovered as a blank page. The theme compiler is
// the other half: it turns that data into a stylesheet served to every visitor,
// which makes it the one place a stored value reaches a browser unescaped.

const base = (): Record<string, unknown> => ({
  name: "sample",
  label: "Sample",
  description: "A template.",
  version: "1.0.0",
  suits: "Anyone.",
  layout: { nav: "bar", hero: "stack", cards: "bordered", align: "left", rhythm: "normal" },
  fonts: [{ family: "Inter", weights: [400, 700], stack: '"Inter", system-ui, sans-serif' }],
  palettes: [
    { id: "one", label: "One", colors: { accent: "#112233" } },
    { id: "two", label: "Two", colors: { accent: "#445566" } },
  ],
  theme: [
    { id: "color", label: "Colour", tokens: [{ key: "accent", label: "Accent", type: "color", default: "#112233" }] },
  ],
  contentTypes: [{ name: "page", label: "Page", fields: [] }],
  sections: [],
})

const rejects = (mutate: (m: Record<string, unknown>) => void, because: string) => {
  const manifest = base()
  mutate(manifest)
  const result = validateTemplate(manifest)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain(because)
}

test("a well-formed manifest is accepted", () => {
  expect(validateTemplate(base()).ok).toBe(true)
})

test("a manifest missing what a renderer needs is refused", () => {
  rejects(m => {
    m.name = "Sample"
  }, "lowercase")
  rejects(m => {
    m.suits = ""
  }, "suits")
  rejects(m => {
    m.fonts = []
  }, "no fonts")
  rejects(m => {
    m.theme = []
  }, "no theme tokens")
  // A template with no content types has nothing to render, which would install
  // cleanly and then show an empty site.
  rejects(m => {
    m.contentTypes = []
  }, "no content types")
})

test("a token that cannot become a CSS value is refused", () => {
  const withToken = (token: unknown) => (m: Record<string, unknown>) => {
    m.theme = [{ id: "color", label: "Colour", tokens: [token] }]
    // Palettes are checked against the colour tokens, so a fixture that swaps
    // the tokens has to swap these too or it fails for the wrong reason.
    m.palettes = [{ id: "one", label: "One", colors: { accent: "#112233" } }]
  }
  // No default means an empty custom property, which is a blank page rather
  // than an error — so it has to fail here.
  rejects(withToken({ key: "accent", label: "A", type: "color" }), "needs a default")
  rejects(withToken({ key: "accent", label: "A", type: "color", default: "rebeccapurple" }), "hex")
  rejects(withToken({ key: "accent", label: "A", type: "number", default: "12" }), "must be one")
  rejects(withToken({ key: "accent", label: "A", type: "gradient", default: "x" }), "not one of")
  rejects(
    withToken({ key: "mode", label: "M", type: "select", default: "c", options: [{ value: "a", label: "A" }] }),
    "not one of its options",
  )
})

test("a font token may only name a family the template declares", () => {
  rejects(m => {
    m.theme = [
      {
        id: "type",
        label: "Type",
        tokens: [{ key: "fontBody", label: "Body", type: "font", default: "Comic Sans MS" }],
      },
    ]
    m.palettes = [{ id: "one", label: "One", colors: {} }]
  }, "does not declare")
})

test("a family with no fallback stack is refused", () => {
  // One family and no fallback means a blocked webfont lands on the browser
  // default, which is never what the template was designed against.
  rejects(m => {
    m.fonts = [{ family: "Inter", weights: [400], stack: "Inter" }]
  }, "fallback stack")
})

test("two tokens cannot claim the same custom property", () => {
  rejects(m => {
    m.theme = [
      { id: "a", label: "A", tokens: [{ key: "accent", label: "A", type: "color", default: "#111111" }] },
      { id: "b", label: "B", tokens: [{ key: "accent", label: "B", type: "color", default: "#222222" }] },
    ]
    m.palettes = [{ id: "one", label: "One", colors: { accent: "#111111" } }]
  }, "twice")
})

// ------------------------------------------------------------------ compiler

const sample = (): Template => (validateTemplate(base()) as { ok: true; template: Template }).template

test("tokens compile to custom properties, and overrides win", () => {
  const css = themeCss(sample(), {})
  expect(css).toContain("--accent: #112233;")
  expect(themeCss(sample(), { accent: "#ABCDEF" })).toContain("--accent: #ABCDEF;")
})

test("a stored value that is not a CSS value falls back to the default", () => {
  // Settings hold whatever JSON the editor produced. An object here would emit
  // `--accent: [object Object]` and render the page unstyled.
  for (const bad of [{}, [], null, "", "   ", Number.NaN]) {
    expect(themeCss(sample(), { accent: bad as never })).toContain("--accent: #112233;")
  }
})

test("a stored value that is not the token's own type is discarded, not sanitised", () => {
  // Character stripping would leave `red  body  display: none` in the value.
  // Checking against the type instead means anything that is not a colour is
  // not a colour, and the template's own default renders.
  expect(themeCss(sample(), { accent: "red; } body { display: none; } :root { --x: y" })).toContain(
    "--accent: #112233;",
  )
  // The reason type-checking beats a blocklist: a URL in a token used for a
  // background is an outbound request on every page load, and it contains none
  // of the characters a blocklist looks for.
  expect(themeCss(sample(), { accent: "url(https://tracker.example/p.gif)" })).toContain("--accent: #112233;")
  expect(themeCss(sample(), { accent: "rgb(12 34 56 / 50%)" })).toContain("--accent: rgb(12 34 56 / 50%);")
})

test("free-form text is the one token with no enumerable type, so it keeps a blocklist", () => {
  const free = validateTemplate({
    ...base(),
    theme: [
      { id: "misc", label: "Misc", tokens: [{ key: "shadow", label: "Shadow", type: "text", default: "0 1px 2px" }] },
    ],
    palettes: [{ id: "one", label: "One", colors: {} }],
  })
  expect(free.ok).toBe(true)
  if (!free.ok) return
  expect(themeCss(free.template, { shadow: "0 4px 12px" })).toContain("--shadow: 0 4px 12px;")
  for (const attack of ["red; } body { display: none", "url(https://x.example/a)", "@import url(x)", "a/*b*/c"]) {
    expect(themeCss(free.template, { shadow: attack })).toContain("--shadow: 0 1px 2px;")
  }
})

test("units attach to numbers and never to strings", () => {
  const withUnit = validateTemplate({
    ...base(),
    theme: [
      {
        id: "layout",
        label: "Layout",
        tokens: [{ key: "radius", label: "Radius", type: "number", default: 8, unit: "px" }],
      },
    ],
    palettes: [{ id: "one", label: "One", colors: {} }],
  })
  expect(withUnit.ok).toBe(true)
  if (!withUnit.ok) return
  expect(themeCss(withUnit.template, {})).toContain("--radius: 8px;")
  expect(themeCss(withUnit.template, { radius: 0 })).toContain("--radius: 0px;")
})

test("the font link asks for exactly the weights declared", () => {
  const href = fontHref([
    { family: "Space Grotesk", weights: [700, 500, 700], stack: '"Space Grotesk", sans-serif' },
    { family: "Inter", weights: [400], italic: true, stack: '"Inter", sans-serif' },
  ])
  expect(href).toContain("family=Space+Grotesk:wght@500;700")
  expect(href).toContain("family=Inter:ital,wght@0,400;1,400")
  expect(href).toContain("display=swap")
  expect(fontHref([])).toBeNull()
})

// --------------------------------------------------------------- the shipped five

test("every template in the registry loads and validates", async () => {
  const loaded = await loadTemplates()
  expect(loaded.length).toBeGreaterThanOrEqual(5)
  for (const entry of loaded) {
    expect(entry.error, `${entry.name}: ${entry.error}`).toBeUndefined()
  }
})

test("all templates share one token vocabulary", async () => {
  // A section writes var(--accent) and has to work in every template. The
  // moment one template renames or drops a token, sections stop being portable
  // and the registry has quietly become five bespoke themes.
  const loaded = await loadTemplates()
  const templates = loaded.map(entry => entry.template).filter((t): t is Template => Boolean(t))
  expect(templates.length).toBeGreaterThanOrEqual(5)

  const first = templates[0]
  if (!first) return
  const vocabulary = tokensOf(first).map(propertyName).sort()
  expect(vocabulary.length).toBeGreaterThan(10)

  for (const template of templates) {
    expect(tokensOf(template).map(propertyName).sort(), `${template.name}`).toEqual(vocabulary)
  }
})

test("every template renders a complete stylesheet with resolved font stacks", async () => {
  const loaded = await loadTemplates()
  for (const entry of loaded) {
    if (!entry.template) continue
    const css = stylesheet(entry.template)
    for (const token of tokensOf(entry.template)) {
      expect(css, `${entry.name} is missing ${propertyName(token)}`).toContain(`${propertyName(token)}:`)
    }
    // A font token must end up as a usable font-family value, not a bare name
    // that dies with the webfont.
    for (const token of tokensOf(entry.template).filter(t => t.type === "font")) {
      const declarations = css.split(`${propertyName(token)}:`)
      expect(declarations.at(-1), `${entry.name} ${token.key}`).toContain(",")
    }
  }
})

test("theme tokens map onto field types the settings editor already renders", async () => {
  const loaded = await loadTemplates()
  const known = new Set(["color", "text", "number", "select"])
  for (const entry of loaded) {
    if (!entry.template) continue
    for (const field of themeFields(entry.template)) {
      // `font` becomes a select of the declared families, which is what keeps
      // theming on the existing settings screen rather than growing its own.
      expect(known.has(field.type), `${entry.name} ${field.key} is ${field.type}`).toBe(true)
      if (field.type === "select") expect((field.options ?? []).length).toBeGreaterThan(0)
    }
  }
})

// ------------------------------------------------------------ designs, not skins

test("no two designs share a layout", async () => {
  // The property this whole distinction exists for. Two templates with the same
  // structure and different colours are one template twice — which is what a
  // palette is *for*, and why palettes live inside a template rather than
  // becoming templates of their own.
  const loaded = await loadTemplates()
  const templates = loaded.map(entry => entry.template).filter((t): t is Template => Boolean(t))
  expect(templates.length).toBeGreaterThanOrEqual(5)

  const signatures = new Map<string, string>()
  for (const template of templates) {
    const { nav, hero, cards, align, rhythm } = template.layout
    const signature = [nav, hero, cards, align, rhythm].join("/")
    const clash = signatures.get(signature)
    expect(clash, `${template.name} has the same layout as ${clash}: ${signature}`).toBeUndefined()
    signatures.set(signature, template.name)
  }
})

test("no two designs share a type pairing", async () => {
  // Structure is most of a design, but two identical typefaces on two different
  // structures still read as one house.
  const loaded = await loadTemplates()
  const seen = new Map<string, string>()
  for (const entry of loaded) {
    if (!entry.template) continue
    const pairing = entry.template.fonts.map(font => font.family).join(" + ")
    const clash = seen.get(pairing)
    expect(clash, `${entry.name} uses the same fonts as ${clash}`).toBeUndefined()
    seen.set(pairing, entry.name)
  }
})

test("every design carries more than one palette, and each is complete", async () => {
  const loaded = await loadTemplates()
  for (const entry of loaded) {
    if (!entry.template) continue
    expect(entry.template.palettes.length, `${entry.name}`).toBeGreaterThan(1)

    const colorKeys = tokensOf(entry.template)
      .filter(token => token.type === "color")
      .map(token => token.key)

    for (const palette of entry.template.palettes) {
      // A palette missing a colour would render that one custom property from
      // the default palette, which is a subtly wrong page rather than a broken
      // one — the worst kind to find by looking.
      expect(Object.keys(palette.colors).sort(), `${entry.name}/${palette.id}`).toEqual([...colorKeys].sort())
    }
  }
})

test("selecting a palette changes every colour and nothing else", async () => {
  const loaded = await loadTemplates()
  for (const entry of loaded) {
    if (!entry.template) continue
    const [first, second] = entry.template.palettes
    if (!first || !second) continue

    const a = themeCss(entry.template, {}, first.id)
    const b = themeCss(entry.template, {}, second.id)
    expect(a, `${entry.name}`).not.toEqual(b)

    for (const token of tokensOf(entry.template)) {
      const line = (css: string) =>
        css
          .split(`${propertyName(token)}:`)[1]
          ?.split("\n")[0]
          ?.trim()
      if (token.type === "color") {
        expect(line(b), `${entry.name} ${token.key}`).toContain(second.colors[token.key] ?? "")
      } else {
        // Type and layout belong to the design, not the palette. If a palette
        // could move them it would be a second template in disguise.
        expect(line(a), `${entry.name} ${token.key}`).toEqual(line(b))
      }
    }
  }
})

test("a hand-set colour survives a palette change", async () => {
  // Overrides are applied after the palette, because the alternative is a
  // colour the operator sets and then cannot keep.
  const loaded = await loadTemplates()
  const template = loaded.find(entry => entry.template)?.template
  expect(template).toBeDefined()
  if (!template) return
  const other = template.palettes[1]
  if (!other) return
  expect(themeCss(template, { accent: "#123456" }, other.id)).toContain("--accent: #123456;")
})
