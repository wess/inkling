# Inkling

A headless CMS with a plugin system, built on [Atlas](https://github.com/wess/atlas).

Content lives here; your websites read it over an HTTP delivery API. Runs on
Postgres or SQLite from the same migration set, with no build step for the API.

## Quick start

```bash
bun install
cp .env.example .env
bun run dev
```

- Admin — http://localhost:4310
- API — http://localhost:4300

On the first visit, the admin asks you to create the owner account. After that,
the same screen becomes the normal sign-in form; there is no public signup.
`BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` remain available for unattended
deployments.

SQLite is the default (`sqlite://./inkling.db`) and needs no setup. For
Postgres, point `DATABASE_URL` at it — the schema is identical.

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
- **Webhooks** on content events, HMAC-signed
- **Activity history** for sign-ins, edits, publishing, and media changes
- **Plugins** that add content types, routes, settings, admin panels, and their
  own database tables
- **Nontechnical admin** for building content models, organizing categories,
  writing rich text, nesting menus, scheduling releases, restoring trash,
  managing users safely, and searching or paging through large libraries

## Plugins

Drop a directory into `plugins/` and enable it in the admin. Five ship with it:

| Plugin | Demonstrates |
|---|---|
| `seo` | A `delivery.entry` filter adding computed metadata to every response |
| `redirects` | A plugin-owned content type plus a public lookup route |
| `forms` | A plugin with its own table via plugin-scoped migrations |
| `commerce` | Content type + taxonomy + settings + a convenience route |
| `analytics` | Cookieless traffic collection, and a `stats` panel that renders as a dashboard |

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

`/Users/wess/Desktop/apothecary` is a worked example: a real site whose every
word, product, and image comes from Inkling while its markup and CSS stay
hand-written.

## Commands

| | |
|---|---|
| `bun run dev` | API + admin, hot-reloading |
| `bun run api` / `bun run web` | either half alone |
| `bun src/start.ts` | production entry, both processes |
| `bun run test` | test suite |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run tidy` | Biome format + lint with fixes |

Postgres tests run automatically when a Postgres is reachable at
`TEST_POSTGRES_URL` (default `postgres://postgres:postgres@localhost:5432/inkling_test`)
and skip otherwise, so `bun test` stays zero-setup.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module layout, data model,
  plugin system, and the dialect-portability rules
- [`CLAUDE.md`](CLAUDE.md) — conventions and the gotchas that cost real bugs
- [`.env.example`](.env.example) — every configuration variable
