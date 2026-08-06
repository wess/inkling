#!/usr/bin/env bun
//
// Renders every template, in every palette, to one HTML file — so five designs
// and fifteen palettes can be looked at rather than read as JSON.
//
//   bun run templates                  # writes .preview/templates.html
//   bun run templates -- --open        # and opens it
//
// The markup below branches on `layout`, and only on `layout`. That is the line
// this file exists to hold: a design differs by structure, and if two templates
// produce the same page with different colours then one of them is a palette
// wearing a template's name. Everything else — every colour, size, family, and
// radius — still comes through custom properties, so nothing here knows what
// any individual template looks like.
//
// This is not the renderer. The renderer resolves entries, sections, and routes
// (see docs/TEMPLATES.md); this proves the theme and layout layers.

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fontHref, stylesheet } from "../src/theme/index.ts"
import type { Palette, Template } from "./registry.ts"
import { loadTemplates } from "./registry.ts"

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// A stand-in image. Inline SVG in the theme's own colours, so a preview needs
// no network and no asset directory.
const art = (ratio: string) =>
  `<svg class="art" style="aspect-ratio:${ratio}" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
     <rect width="100" height="100" fill="var(--surface)"/>
     <circle cx="70" cy="30" r="19" fill="var(--accent)" opacity="0.9"/>
     <path d="M0 100 L34 44 L62 100 Z" fill="var(--text)" opacity="0.14"/>
     <path d="M40 100 L72 56 L100 100 Z" fill="var(--accent)" opacity="0.28"/>
   </svg>`

const SHARED = `
  *, *::before, *::after { box-sizing: border-box; }

  .t {
    background: var(--bg); color: var(--text);
    font-family: var(--fontBody); font-size: var(--baseSize); line-height: var(--lineHeight);
  }
  .t h1, .t h2, .t h3 {
    font-family: var(--fontDisplay); font-weight: var(--displayWeight);
    letter-spacing: var(--displayTracking); text-transform: var(--displayCase);
    line-height: 1.06; margin: 0;
  }
  .t h1 { font-size: calc(var(--baseSize) * var(--scale) * var(--scale) * var(--scale)); }
  .t h2 { font-size: calc(var(--baseSize) * var(--scale) * var(--scale)); }
  .t h3 { font-size: calc(var(--baseSize) * var(--scale)); }
  .t p  { margin: 0; }
  .art  { display: block; width: 100%; border-radius: var(--radius); }

  .wrap { width: min(100% - calc(var(--space) * 2), var(--frame)); margin-inline: auto; }
  .lede { color: var(--textMuted); max-width: var(--measure); }

  /* rhythm ------------------------------------------------------------- */
  [data-rhythm="tight"]  { --beat: calc(var(--space) * 1.6); }
  [data-rhythm="normal"] { --beat: calc(var(--space) * 2.2); }
  [data-rhythm="airy"]   { --beat: calc(var(--space) * 3.2); }
  .band { padding-block: var(--beat); }

  /* alignment ---------------------------------------------------------- */
  [data-align="center"] .hero,
  [data-align="center"] .heading { text-align: center; }
  [data-align="center"] .lede { margin-inline: auto; }

  /* navigation --------------------------------------------------------- */
  .mark { font-family: var(--fontDisplay); font-weight: var(--displayWeight);
          letter-spacing: var(--displayTracking); text-transform: var(--displayCase);
          font-size: calc(var(--baseSize) * 1.25); }
  .links { display: flex; gap: calc(var(--space) * 1.1); font-size: calc(var(--baseSize) * 0.8); }
  .links span { color: var(--textMuted); }

  [data-nav="bar"] .nav { display: flex; align-items: center; gap: var(--space);
                          padding-block: calc(var(--space) * 0.85);
                          border-bottom: var(--borderWidth) solid var(--border); }
  [data-nav="bar"] .nav .mark { margin-right: auto; }

  [data-nav="stacked"] .nav { display: grid; justify-items: center; gap: calc(var(--space) * 0.7);
                              padding-block: calc(var(--space) * 1.6) calc(var(--space) * 0.9);
                              border-bottom: var(--borderWidth) solid var(--border); }
  [data-nav="stacked"] .mark { font-size: calc(var(--baseSize) * 1.9); }
  [data-nav="stacked"] .links { letter-spacing: 0.16em; text-transform: uppercase;
                                font-size: calc(var(--baseSize) * 0.68); }

  /* The rail is the one layout that restructures the page rather than its
     header: content gets a column, navigation gets its own. */
  [data-nav="rail"] .page { display: grid; grid-template-columns: 15rem 1fr; align-items: start; }
  [data-nav="rail"] .nav { position: sticky; top: 0; display: grid; align-content: start;
                           gap: calc(var(--space) * 2); min-height: 100vh;
                           padding: calc(var(--space) * 1.4);
                           border-right: var(--borderWidth) solid var(--border); }
  [data-nav="rail"] .links { flex-direction: column; gap: calc(var(--space) * 0.5); }
  [data-nav="rail"] .rail-body { min-width: 0; padding-inline: calc(var(--space) * 1.6); }
  [data-nav="rail"] .wrap { width: 100%; }
  @media (max-width: 860px) {
    [data-nav="rail"] .page { grid-template-columns: 1fr; }
    [data-nav="rail"] .nav { position: static; min-height: 0; border-right: 0;
                             border-bottom: var(--borderWidth) solid var(--border); }
    [data-nav="rail"] .links { flex-direction: row; flex-wrap: wrap; }
  }

  /* hero --------------------------------------------------------------- */
  .hero { display: grid; gap: calc(var(--space) * 1.1); }
  .hero .lede { font-size: calc(var(--baseSize) * 1.14); }

  .hero-split { display: grid; gap: calc(var(--space) * 2); align-items: center;
                grid-template-columns: 1.05fr 0.95fr; }
  @media (max-width: 820px) { .hero-split { grid-template-columns: 1fr; } }

  /* Editorial sets the opening as type alone — no image, a rule under it, and
     a headline large enough to be the whole event. */
  .hero-editorial { border-bottom: var(--borderWidth) solid var(--border);
                    padding-bottom: calc(var(--space) * 1.6); }
  .hero-editorial h1 { font-size: calc(var(--baseSize) * var(--scale) * var(--scale) * var(--scale) * 1.08); }
  .hero-editorial .kicker { font-size: calc(var(--baseSize) * 0.7); letter-spacing: 0.24em;
                            text-transform: uppercase; color: var(--textMuted); }

  /* Banner puts the title over the image rather than beside it. */
  .hero-banner { position: relative; display: grid; place-items: center; isolation: isolate;
                 min-height: 24rem; padding: calc(var(--space) * 3) var(--space); overflow: hidden;
                 border-radius: var(--radius); }
  .hero-banner .art { position: absolute; inset: 0; z-index: -2; height: 100%; border-radius: 0; }
  .hero-banner::after { content: ""; position: absolute; inset: 0; z-index: -1;
                        background: var(--bg); opacity: 0.74; }
  .hero-banner .inner { display: grid; gap: calc(var(--space) * 0.9); justify-items: center; text-align: center; }

  /* buttons ------------------------------------------------------------ */
  .btn {
    display: inline-block; justify-self: start; text-decoration: none;
    background: var(--accent); color: var(--accentText);
    border: var(--borderWidth) solid var(--accent); border-radius: var(--radius);
    padding: calc(var(--space) * 0.5) calc(var(--space) * 1.05);
    font-family: var(--fontDisplay); font-weight: var(--displayWeight);
    letter-spacing: var(--displayTracking); text-transform: var(--displayCase);
    font-size: calc(var(--baseSize) * 0.86);
  }
  [data-align="center"] .btn { justify-self: center; }

  /* cards -------------------------------------------------------------- */
  .cards { display: grid; gap: var(--space); grid-template-columns: repeat(3, 1fr); }
  @media (max-width: 820px) { .cards { grid-template-columns: 1fr; } }
  .card { display: grid; gap: calc(var(--space) * 0.4); align-content: start; }
  .card p { font-size: calc(var(--baseSize) * 0.92); color: var(--textMuted); max-width: var(--measure); }

  [data-cards="bordered"] .card { border: var(--borderWidth) solid var(--border);
                                  border-radius: var(--radius); padding: calc(var(--space) * 1.1); }
  [data-cards="filled"]   .card { background: var(--surface); border-radius: var(--radius);
                                  padding: calc(var(--space) * 1.3); }
  [data-cards="raised"]   .card { background: var(--bg); border: var(--borderWidth) solid var(--border);
                                  border-radius: var(--radius); padding: calc(var(--space) * 1.1);
                                  box-shadow: 0 1px 2px rgb(0 0 0 / 5%), 0 8px 24px rgb(0 0 0 / 6%); }
  /* Plain is a ruled list, not a box — which is why the grid collapses to one
     column for it. A magazine does not put its contents in cards. */
  [data-cards="plain"] .cards { grid-template-columns: 1fr; gap: 0; }
  [data-cards="plain"] .card { border-top: var(--borderWidth) solid var(--border);
                               padding-block: calc(var(--space) * 1.1); }

  .heading { display: grid; gap: calc(var(--space) * 0.5); margin-bottom: calc(var(--space) * 1.3); }

  .swatches { display: flex; border: var(--borderWidth) solid var(--border);
              border-radius: var(--radius); overflow: hidden; }
  .swatch { flex: 1; height: calc(var(--space) * 2.4); display: grid; align-content: end;
            padding: calc(var(--space) * 0.35); font-size: 9px; letter-spacing: 0.04em; }
`

const nav = (template: Template) => `
  <div class="nav">
    <span class="mark">${escape(template.label)}</span>
    <div class="links"><span>Work</span><span>About</span><span>Journal</span><span>Contact</span></div>
  </div>`

const hero = (template: Template) => {
  const title = "Everything in its place"
  const lede = escape(template.description)

  switch (template.layout.hero) {
    case "split":
      return `<div class="hero-split">
        <div class="hero"><h1>${title}</h1><p class="lede">${lede}</p><a class="btn" href="#">Get in touch</a></div>
        ${art("4 / 3")}
      </div>`
    case "banner":
      return `<div class="hero-banner">
        ${art("16 / 9")}
        <div class="inner"><h1>${title}</h1><p class="lede">${lede}</p><a class="btn" href="#">Get in touch</a></div>
      </div>`
    case "editorial":
      return `<div class="hero hero-editorial">
        <span class="kicker">Issue 01</span>
        <h1>${title}</h1>
        <p class="lede">${lede}</p>
      </div>`
    default:
      return `<div class="hero"><h1>${title}</h1><p class="lede">${lede}</p><a class="btn" href="#">Get in touch</a></div>`
  }
}

const CARDS: readonly (readonly [string, string])[] = [
  ["Considered", "Every decision made once, written down, and left alone afterwards."],
  ["Durable", "Built to be handed over. Nothing here needs the person who made it."],
  ["Quiet", "It gets out of the way, which is the hardest thing to design for."],
]

const body = () => `
  <div class="band">
    <div class="wrap">
      <div class="heading">
        <h2>What we do</h2>
        <p class="lede">Three things, and nothing else until these are right.</p>
      </div>
      <div class="cards">
        ${CARDS.map(([title, text]) => `<div class="card"><h3>${title}</h3><p>${text}</p></div>`).join("")}
      </div>
    </div>
  </div>`

const swatches = () => `
  <div class="band" style="padding-top:0">
    <div class="wrap">
      <div class="swatches">
        ${["bg", "surface", "border", "accent", "text", "textMuted"]
          .map(key => {
            const on = key === "accent" ? "accentText" : key === "text" || key === "textMuted" ? "bg" : "text"
            return `<div class="swatch" style="background:var(--${key});color:var(--${on})">${key}</div>`
          })
          .join("")}
      </div>
    </div>
  </div>`

const page = (template: Template, palette: Palette): string => {
  const id = `${template.name}-${palette.id}`
  const attrs =
    `data-skin="${id}" data-nav="${template.layout.nav}" data-hero="${template.layout.hero}" ` +
    `data-cards="${template.layout.cards}" data-align="${template.layout.align}" data-rhythm="${template.layout.rhythm}"`

  const inner =
    template.layout.nav === "rail"
      ? `<div class="page">${nav(template)}<div class="rail-body"><div class="band">${hero(template)}</div>${body()}${swatches()}</div></div>`
      : `<div class="wrap">${nav(template)}</div><div class="band"><div class="wrap">${hero(template)}</div></div>${body()}${swatches()}`

  return `<section class="t" ${attrs}>${inner}</section>`
}

// ---------------------------------------------------------------------------

const loaded = await loadTemplates()
for (const entry of loaded.filter(e => e.error)) console.error(`  ${entry.name}: ${entry.error}`)
const ok = loaded.map(entry => entry.template).filter((t): t is Template => Boolean(t))

const links = [...new Set(ok.map(template => fontHref(template.fonts)).filter(Boolean))]
  .map(href => `<link rel="stylesheet" href="${href}">`)
  .join("\n")

// One scoped block per template *and* palette, so fifteen skins coexist on a
// single page without :root fighting itself.
const skins = ok
  .flatMap(template =>
    template.palettes.map(palette =>
      stylesheet(template, {}, palette.id).replaceAll(":root", `[data-skin="${template.name}-${palette.id}"]`),
    ),
  )
  .join("\n")

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inkling templates</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${links}
<style>
  body { margin: 0; background: #0B0B0D; }
  .label { font: 500 11px/1.5 ui-monospace, monospace; letter-spacing: 0.16em; text-transform: uppercase;
           color: #8A8A93; padding: 36px 26px 4px; }
  .label b { color: #FAFAFA; font-weight: 500; }
  .label i { color: #52525B; font-style: normal; }
  .pal { font: 500 10px/1 ui-monospace, monospace; letter-spacing: 0.14em; text-transform: uppercase;
         color: #71717A; padding: 18px 26px 8px; }
${SHARED}
${skins}
</style>
</head>
<body>
${ok
  .map(
    template => `
<p class="label"><b>${escape(template.label)}</b> — ${escape(template.suits)}<br>
<i>nav ${template.layout.nav} · hero ${template.layout.hero} · cards ${template.layout.cards} · ${template.layout.align} · ${template.layout.rhythm}</i></p>
${template.palettes
  .map(palette => `<p class="pal">${escape(template.label)} · ${escape(palette.label)}</p>${page(template, palette)}`)
  .join("\n")}`,
  )
  .join("\n")}
</body>
</html>
`

const out = resolve(new URL("..", import.meta.url).pathname, ".preview")
mkdirSync(out, { recursive: true })
const file = `${out}/templates.html`
writeFileSync(file, html)

const palettes = ok.reduce((total, template) => total + template.palettes.length, 0)
console.log(`${ok.length} designs, ${palettes} palettes -> ${file}`)
if (process.argv.includes("--open")) await Bun.$`open ${file}`.quiet()
