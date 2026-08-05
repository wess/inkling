# Inkling

A headless CMS with a plugin system, built on [Atlas](https://github.com/wess/atlas).

Content lives here; your websites read it over an HTTP delivery API. Runs on
Postgres, with no build step for the API.

## Quick start

```bash
bun install
cp .env.example .env
bun run dev
```

Open **http://localhost:4300**. That is the whole thing — one process, one port.

On the first visit, the admin asks you to create the owner account. After that,
the same screen becomes the normal sign-in form; there is no public signup.
`BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` remain available for unattended
deployments.

## One origin, split by path

There is no separate admin server, no proxy, and no bundler running alongside.
One process serves everything, and the URL says which audience a request belongs
to:

| Path | Who calls it |
|---|---|
| `/` | The admin. Any path the router doesn't claim is an admin screen |
| `/api/…` | Everything that needs a session — the admin's whole surface |
| `/content`, `/site` | Your websites, with an API key |
| `/preview/:token` | Whoever you sent a share link to |
| `/media/file/…` | Anything rendering an image |
| `/ext/…` | Plugin routes |
| `/realtime` | The WebSocket |

The split is by audience rather than by module: a feature with both a public and
a session-gated route exports two arrays instead of being mounted twice. That is
what keeps `/settings` — an admin screen — from colliding with `/api/settings`,
the API, and six other paths with it.

Point `DATABASE_URL` at a Postgres database — the same engine in development
as in production, so a dialect difference cannot wait until deploy day to
appear. The test suite runs on in-memory SQLite, so `bun test` still needs no
database of its own.

## What's in the box

- **Content types** you define in the admin — 18 field types including nested
  repeaters, media pickers, and cross-entry references
- **Entries** with draft / review / scheduled / published states, full revision
  history with version previews, soft-delete and restore, per-locale slugs,
  and configurable links to the live page
- **Media library** with an S3-compatible or local-disk driver
- **Taxonomies**, menus, and site settings
- **Delivery API** — key-authenticated, published-only, with media and
  references expanded inline
- **Realtime** — one WebSocket that pushes content changes to the admin (with
  presence, so you can see who else is in a record) and to consuming sites, so
  caches invalidate without polling
- **Shareable previews** — a signed, hour-long link that shows an unpublished
  entry to someone who has no account
- **Bulk actions** and one-click duplication across a selection
- **An editorial assistant** — connect your own AI provider and get drafting,
  rewriting, summarizing, titles, and metadata that know your content model.
  Optional, off until you connect one, and available to the public site as a
  page-aware plugin. Connect it with an API key, or by authorizing an account
  over OAuth
- **An agent for page work** — ask for a page to be reshaped, rewritten, or
  drafted and it reads your content types, entries, and media before answering.
  It proposes; you review a diff and apply, and applying is an ordinary save, so
  every change leaves a revision you can restore
- **Webhooks** on content events, HMAC-signed
- **Activity history** for sign-ins, edits, publishing, and media changes
- **Plugins** that add content types, routes, settings, admin panels, and their
  own database tables
- **Nontechnical admin** for building content models, organizing categories,
  writing rich text, nesting menus, scheduling releases, restoring trash,
  managing users safely, and searching or paging through large libraries

## Plugins

Drop a directory into `plugins/` and enable it in the admin. Seven ship with it:

| Plugin | Demonstrates |
|---|---|
| `seo` | A `delivery.entry` filter adding computed metadata to every response |
| `redirects` | A plugin-owned content type plus a public lookup route |
| `forms` | A plugin with its own table via plugin-scoped migrations |
| `commerce` | Content type + taxonomy + settings + a convenience route |
| `analytics` | Cookieless traffic collection, and a `stats` panel that renders as a dashboard |
| `assistant` | A public, page-aware assistant answering from published content only |
| `social` | Social media management — a queue, a calendar, and a performance report built out of four content types and one results table |

```ts
import { definePlugin } from "../../src/plugins/define.ts"

export default definePlugin({
  name: "hello",
  version: "1.0.0",
  settings: [{ key: "greeting", label: "Greeting", type: "text", default: "Hi" }],
  panels: [{ id: "hello", label: "Hello", kind: "settings" }],

  routes: ctx => [
    get("/greet", async c => json(c, 200, { message: await ctx.getSetting("greeting", "Hi") })),
  ],

  register: ctx => {
    ctx.filter("delivery.entry", ({ payload, type, raw }) => ({
      payload: { ...payload, greeted: true },
      type,
      raw,
    }))
  },
})
```

Routes land at `/ext/hello/greet` and are live the moment the plugin is enabled
— no restart. A plugin can observe any core event without being able to break
it: `emit` hook failures are isolated, and a throwing `filter` degrades to a
no-op rather than blanking the payload.

## Reading content from a site

Mint a key in the admin under **API keys**, then:

```bash
curl http://localhost:4300/content/product \
  -H "x-api-key: ink_…"
```

```json
{
  "data": [{
    "id": "…", "slug": "blue-lotus", "title": "Blue Lotus Refresher",
    "publishedAt": "2026-07-27T21:16:36.141Z",
    "data": {
      "price": 7.5,
      "image": { "url": "http://localhost:4300/media/file/…", "alt": "…", "width": 800 }
    }
  }],
  "meta": { "type": "product", "total": 1, "page": 1, "limit": 20 }
}
```

Media and reference fields arrive expanded, so rendering a page takes one
request. `?include=terms` attaches taxonomy terms; `GET /content` lists the
types a key may read along with their field shapes.

### Staying in sync

Rather than polling, hold a socket. Exchange your key for a short-lived ticket,
connect, and subscribe to the types you render:

```js
const { ticket } = await fetch("http://localhost:4300/realtime/delivery/ticket", {
  method: "POST",
  headers: { "x-api-key": process.env.INKLING_KEY },
}).then(r => r.json())

const socket = new WebSocket(`ws://localhost:4300/realtime?ticket=${ticket}`)
socket.onopen = () => socket.send(JSON.stringify({ action: "subscribe", topic: "content:product" }))
socket.onmessage = event => {
  const { event: name, data } = JSON.parse(event.data)
  if (name === "entry.published") revalidate(`/products/${data.slug}`)
}
```

Frames carry the id, slug, and type — never the content. Re-read the entry
through `/content` when you get one, so scopes and publication status are
enforced on the way out. A key hears only about published content, and only for
types it is scoped to.

`/Users/wess/Desktop/apothecary` is a worked example: a real site whose every
word, product, and image comes from Inkling while its markup and CSS stay
hand-written.

## Running more than one site

Inkling is single-tenant, and three things in the schema say so: core settings
all live under one `site` scope, menu names are globally unique, and `PUBLIC_URL`
is one origin per process. A delivery key's scopes partition **content types**
and nothing else.

So the unit of separation is the database:

| You want | Run |
|---|---|
| Sites with their own settings, menus, and origin | One instance per site — a `DATABASE_URL` each |
| Sites that are one property, sharing a team and a content model | One instance, a scoped key per site |

Three separate sites is three `DATABASE_URL`s. They can share a Postgres server
and a bucket; what they cannot share is a schema. Each instance needs its own
`SECRET` — rotating one invalidates that instance's sessions and stored AI
credentials, and there is no reason for that blast radius to cross sites.

### Or mount it inside the site

A site that would rather not deploy a second service can mount Inkling in its own
process. Install it from GitHub — there is no npm release:

```bash
bun add github:wess/inkling          # or github:wess/inkling#v0.2.0 to pin
```

Nothing else is needed to make it resolve: Inkling imports Atlas as bare
`atlas/<pkg>` specifiers that go through Atlas's own `exports` map, so no
`tsconfig.json` `paths` entry is involved. (An aliased `@atlas/<pkg>` would not
survive the trip — Bun does not apply a consuming project's tsconfig paths to
files under `node_modules`.)

`createInkling` returns a handler rather than a server:

```ts
import { createInkling } from "inkling"

const inkling = await createInkling({ adminBase: "/admin", siteKeyName: "site" })

Bun.serve({
  fetch: async (request, server) => {
    if (request.headers.get("upgrade") === "websocket") {
      if (inkling.upgrade(request, server)) return undefined as unknown as Response
    }
    // null means no Inkling route claimed the path — keep routing.
    return (await inkling.fetch(request, server)) ?? myOwnRouter(request)
  },
  websocket: inkling.websocket,
})
```

`adminBase` confines the admin to a prefix and makes `fetch` return `null`
everywhere else, so Inkling never swallows a path it does not own. `siteKeyName`
mints a delivery key for the site sharing the process, derived from `SECRET` so
it is the same key on every boot — an in-process consumer has no browser in which
to visit the admin and copy one.

This is still one instance per process: `config` and the database connection are
module-level, so mounting twice gives you two route sets over the same data.

## Commands

| | |
|---|---|
| `bun run dev` | Everything, hot-reloading |
| `bun run start` | Production entry |
| `bun run test` | Test suite |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run tidy` | Biome format + lint with fixes |

Postgres tests run automatically when a Postgres is reachable at
`TEST_POSTGRES_URL` (default `postgres://postgres:postgres@localhost:5432/inkling_test`)
and skip otherwise, so `bun test` stays zero-setup.

## Documentation

- **[wess.io/inkling](https://wess.io/inkling/)** — the site
  - [Get set up](https://wess.io/inkling/start/) — empty database to a live site
  - [Guide](https://wess.io/inkling/guide/) — the model, delivery, realtime,
    previews, AI, plugins, and running more than one site
  - [Tutorials](https://wess.io/inkling/tutorials/) — a blog end to end, writing
    a plugin, three sites at once, mounting it inside a site
  - [Reference](https://wess.io/inkling/reference/) — every route, field type,
    variable, and command
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module layout, data model,
  plugin system, realtime, previews, AI, and the dialect-portability rules
- [`llms.txt`](https://wess.io/inkling/llms.txt) — the same ground in one pass,
  written to be read by an agent before it touches the code
- [`.env.example`](.env.example) — every configuration variable

`docs/` is the site. Anything committed there publishes to the `gh-pages` branch
on push (`.github/workflows/pages.yml`), so `llms.txt` lands at the site root
where agents look for it.
