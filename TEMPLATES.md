# Templates

How Inkling offers what Squarespace offers without becoming what Squarespace is.

This is a design document, not a description of what exists. What exists today
is `templates/` — the registry, the manifest format, and five templates — and
the theme compiler in `src/theme/`. The renderer is not built yet, and the
phases at the bottom say what lands when.

## The problem

Squarespace and WordPress can offer templates because they own rendering. A
non-technical person picks a template, their content appears inside it, and they
are live in ten minutes.

Inkling's whole positioning is the opposite, and deliberately so: it stores
content and does not render your site. That sentence is in the README, in the
guide, and in Inky's system prompt. Every consuming site — apothecary, 803media
— hand-writes its own markup and reads content over the delivery API.

Those two facts look irreconcilable. They aren't, and the reason is worth
stating precisely, because it determines everything else in this document.

**The reason Inkling can't do templates today is that layout and style live in
the site's code. Move them into content, and Inkling is no longer rendering
your code — it is rendering your content, which is the thing it already owns.**

The promise survives intact. Inkling still does not render. A separate package
does, out of data Inkling stores.

## The insight that makes this cheap

A page built of sections is a `list` field.

`list` already nests, already validates recursively (`validateDefinition` calls
itself on `field.fields`), and already renders an editor. So:

- a **section** is a field set — the same 18 field types everything else uses
- a **page's layout** is a `sections` list field on that page's entry
- a **theme** is a settings scope of typed tokens

Every one of those is a primitive that shipped in 0.2. The template system is
mostly assembly. The genuinely new parts are a sandboxed render pipeline and the
package format, and nothing else.

## What a template is

Six things, and the last is the one people skip:

| Part | What it is |
|---|---|
| Layout | Where the navigation sits, how the opening reads, what a card is |
| Content types | The model — Page, Post, Product |
| Sections | Markup plus a field schema, one per section |
| Theme tokens | What a user may change without touching markup |
| Palettes | Named colour sets within the design |
| Demo content | So it looks finished the moment it installs |

Demo content is not a nicety. Squarespace feels like magic because you get a
complete-looking site immediately and replace the words. A template that
installs to a blank page is a blank page with extra steps.

## Templates are data, not code

This is the decision the rest hangs off, and the marketplace forces it.

**Untrusted JavaScript cannot run on our infrastructure.** The moment a
marketplace exists, a template is code from a stranger. WordPress's entire
security history is this one mistake: themes are arbitrary PHP, running with the
application's full privileges, installed by people who cannot audit them.

So a section is a template file in a logic-less language — Liquid via
`liquidjs`, or Handlebars — with a schema declaring its fields. No arbitrary
code, no filesystem, no network, no database handle. Sandboxed by construction
rather than by review. This is Shopify's model, and its theme store is the
existence proof that it works at scale.

**Build the sandboxed format from the first template, including our own.** The
tempting shortcut is TSX for first-party templates, since we trust ourselves,
and the safe format later. That is a trap with two costs: every template gets
written twice, and the second format ends up shaped by constraints discovered
too late to act on cheaply.

## Where it lives

Not in core. A separate package mounted *alongside* Inkling, using the
fall-through contract that already exists — `createInkling().fetch` returns
`null` for any path it does not claim:

```ts
const cms  = await createInkling({ adminBase: "/admin" })
const site = await createSite(cms, { template: "quarto" })

Bun.serve({
  fetch: async (request, server) => (await cms.fetch(request, server)) ?? site.fetch(request),
  websocket: cms.websocket,
})
```

That is the exact shape apothecary and 803media already use. They just
hand-write what `site` would render.

Two consequences worth naming. **Existing sites are untouched** — they never
mount it, so nothing about them changes. And **the promise holds literally**:
Inkling does not render; `createSite` does.

## A design is structure, not colour

The distinction that keeps a registry from becoming five reskins of one page:
**a template is a layout, and a palette is a colour set inside it.** Two
templates with the same structure and different colours are one template twice.

Layout is a closed set of declared choices — where the navigation sits (`bar`,
`stacked`, `rail`), how the opening reads (`stack`, `split`, `banner`,
`editorial`), what a card is (`bordered`, `filled`, `raised`, `plain`), plus
alignment and rhythm. Closed, because a marketplace template must not ship
arbitrary markup, and because a fixed vocabulary is what lets one section work
in every design.

`tests/templates.test.ts` asserts no two shipped templates share a layout
signature or a type pairing. It is easy to add a sixth template that is really
the fifth in another colour, and the test is what makes that fail loudly rather
than quietly.

## Palettes

A design carries several palettes, the way a Squarespace family does. The colour
*tokens* remain the single source of truth for which colours exist; a palette
only supplies an alternative set of values for them, and is validated against
them — so a palette can never miss a colour or invent one. The first palette is
the default, and the registry refuses a template whose first palette disagrees
with its own token defaults.

Resolution is three layers, innermost first: the token's default, the chosen
palette, then anything the operator changed by hand. Overrides win, because the
alternative is a colour someone sets and then cannot keep.

The five shipped designs carry three palettes each, three of them dark.

## Theme tokens

A theme is a set of typed tokens grouped for the settings screen, each carrying
a default. Tokens compile to CSS custom properties on `:root`, which is the
entire contract between a theme and the markup that consumes it — a section
never reads a token by name in code, it writes `var(--accent)` in CSS.

```json
{ "key": "accent", "label": "Accent", "type": "color", "default": "#B4451F" }
```

becomes

```css
:root { --accent: #B4451F; }
```

Token types are a deliberate subset of the field types: `color`, `text`,
`number`, `select`, and `font`. No `media`, no `reference`, no `list` — a token
resolves to a single CSS value, and anything that cannot is a section field
instead.

`font` is `text` with a registry behind it. A theme declares the families it
uses in `fonts`, and the compiler emits one stylesheet link for the set. A
marketplace template may only name families from that declared list, which is
what keeps a template from turning into an arbitrary outbound request.

Because tokens are ordinary Inkling settings under a scope, they get the
settings editor, the audit trail, and revision-free live editing for free.

## What this unlocks for Inky

Today Inky has to say: *colours, fonts, spacing, and layout live in your site's
own code, which I cannot see or edit.* It is the only apology in the product.

If sections are content and theme tokens are settings, **Inky can already change
both** — `propose_entry_update` for a sections list, `propose_settings_update`
for theme tokens. Both tools exist. No new capability, no new tool, and no
relaxing of the rule that every tool is a read or an inert proposal.

"Add a testimonials section under the hero and make the headings warmer" becomes
a diff you approve. Neither Squarespace nor WordPress can do that, and the
realtime channel already in place makes the preview update as it proposes.

## Positioning

**Against Squarespace.** They own the content and there is no API worth leaving
through. Inkling gives a template *and* a real delivery API: start on a
template, outgrow it into headless, keep the content. Nobody offers that.

**Against WordPress.** Themes are arbitrary PHP. Ours are data. That is not a
marketing claim, it is an architectural one, and it is checkable.

## The registry

`templates/` is the registry. One directory per template, a `template.json`
manifest in each, loaded and validated by `templates/registry.ts`.

Today it is a directory in this repository. It is shaped as a registry — a
manifest per template, a loader that validates against a schema, and no
implicit coupling to the surrounding source — because it eventually becomes
something a template is fetched from rather than shipped in, and discovering
that shape later would mean rewriting every template.

## Phases

1. **Tokens, registry, templates.** The manifest format, the theme compiler,
   five designs, and fifteen palettes. `bun run templates` renders all of them
   to one page. *This is what exists.*
2. **The renderer.** `createSite`, Liquid sections, page routing, caching.
3. **Sections in the editor.** The `list` editor already reorders and adds; that
   is most of a page builder without building one.
4. **Packaging.** Install a template from a URL. Where the sandbox earns its
   keep.
5. **Marketplace.** On hold.

## What is genuinely hard

- **The visual editor.** Squarespace's is years of work. Phase 1 must not
  attempt it. "Pick a template, edit content in the admin, tweak tokens" is
  enough to ship, and pretending otherwise is how this stalls at 70%.
- **Template upgrades.** If someone customises and the template updates, what
  wins? Shopify's answer is right: customisations live in settings, separate
  from template files, and updates are opt-in.
- **Caching.** Rendering per request will not hold. Delivery responses are
  already private-cacheable; rendered pages need the same discipline plus
  invalidation off the realtime bus.
- **Custom domains and TLS.** Needed even self-hosted. Caddy does on-demand
  ACME, which is most of it.
