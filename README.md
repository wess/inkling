# Inkling

[![Check](https://github.com/wess/inkling/actions/workflows/check.yml/badge.svg)](https://github.com/wess/inkling/actions/workflows/check.yml)
[Live School](https://inkling.wess.dev/) · [Documentation](https://wess.io/inkling/) · [MIT License](LICENSE)

A headless CMS with a plugin system and an agent that can work the whole of it,
built on [Atlas](https://github.com/wess/atlas).

The live Inkling School is at [inkling.wess.dev](https://inkling.wess.dev/).
It is the public test site for Inkling itself; the admin is at
[`/admin`](https://inkling.wess.dev/admin).

Content lives here; your websites read it over an HTTP delivery API. One process
on one port, running on Postgres, with no build step for the API.

Two things set it apart from the rest of the field. **Inky** sits in the corner
of every admin screen and knows which screen that is — describe a change in
ordinary words and it reads your site, works out what you meant, and hands you a
diff. And a **visitor bubble** you can add to the public site with one script
tag, answering only from what you have published, under rules you write.

Documentation is at **[wess.io/inkling](https://wess.io/inkling/)**.

## Quick start

```bash
bun install
cp .env.example .env
bun run dev
```

Open **http://localhost:4300**. That is the whole thing — one process, one port.

On the first visit, the admin asks you to create the owner account — the first
person through the door becomes the owner. After that the same screen becomes
the normal sign-in form, the setup route closes permanently, and there is no
public signup. `BOOTSTRAP_EMAIL` and `BOOTSTRAP_PASSWORD` remain available for
unattended deployments.

If that owner ever loses their password, `bun run password` sets a new one from
the machine that runs the database. Nothing in the browser can help there:
`POST /auth/password` needs the current password, changing someone else's needs
an admin, and setup is closed.

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
- **An editorial assistant** — drafting, rewriting, summarizing, titles, and
  metadata that know your content model, on the fields where you are already
  working. Connect it with an API key or by authorizing an account over OAuth
- **[Inky](#inky)**, an agent with the run of the site — pages, models, media,
  navigation, categories, people, keys, plugins, and social setup — and a
  **visitor bubble** for your public pages. Both optional, both off until you
  connect a provider
- **Webhooks** on content events, HMAC-signed
- **Activity history** for sign-ins, edits, publishing, and media changes
- **Plugins** that add content types, routes, settings, admin panels, and their
  own database tables
- **Nontechnical admin** for building content models, organizing categories,
  writing rich text, nesting menus, scheduling releases, restoring trash,
  managing users safely, and searching or paging through large libraries

## Inky

Connect a provider under **Settings → AI** — Claude, OpenAI, Ollama on your own
machine, or Ollama Cloud — and Inky appears in the corner of every admin screen.
Nothing in the admin mentions AI until you do; the credential is sealed with
AES-GCM under a key derived from `SECRET`, kept in its own table, and never
returned by the API.

It is built for the person who did *not* build the site. You describe what you
want the way you would say it out loud, and Inky works out whether that is a
change to what a page says, to what a page is made of, to your navigation, your
categories, your site details, who has an account, or a network you are trying
to connect for the first time:

```
you   We need a page about our new roastery, and put it in the menu.

inky  read  your page shapes … 3 kinds
      read  two existing pages, for the voice
      drafted  "Our Roastery" — intro, body, hours
      queued   a menu item under Visit

      Both are waiting for you to look at. Nothing is live yet.

you   I want to start posting these to Instagram.

inky  read  your social setup … no app registered for Instagram
      Instagram goes through a Facebook app, which is the part that
      catches everyone out. I will walk you through it — first, are you
      an admin of the Facebook Page the account is linked to?
```

Because the dock travels with you, "make this shorter" on an open post has no
ambiguity about *this* — the screen you are on is handed over with the question.
And it moves you: ask how to start posting to Instagram and you end up on the
right screen with the next step said in one sentence, rather than reading
directions to it.

**Every tool it has is a read.** Inky has thirty-eight tools: thirteen read your
site, twenty-four record a *proposal*, and one moves the admin. None of them
writes, and no setting makes them able to. The admin renders a proposal as a
diff, and applying it sends the change through the same route your own edit takes
— so revisions, field validation, slug uniqueness, reference checks, and the
audit trail all keep working, and the history names the person who approved it
rather than a machine nobody can ask.

**What it is offered depends on who is asking.** Each tool names the permission
its proposal will need, and the list is filtered to what your role could actually
apply — so an author is never shown the site settings and never queues a change
that dead-ends on a greyed button.

Setting things up is half of what it is for. Social posting needs a developer app
registered with the network, its client ID and secret saved here, and an account
connected — three states, and the usual answer is that one of them is missing.
Inky reads which, then walks you through that network's console a step at a time,
in its own words, with the redirect URI quoted exactly. Four things still need
your hands, and it takes you to them rather than describing the route: uploading
a file, creating an account, pressing Connect, and pasting a client secret — a
secret is a password, and Inky is told never to ask you to type one into a chat.

What it will not do is pretend. Inkling stores content; it does not render your
site. Colours, fonts, spacing, and layout live in your own code, which Inky
cannot see. Ask for something visual and it finds the content-shaped version of
the request, then tells you which part belongs to whoever builds the site.

### A bubble for your visitors

The public-facing assistant is the `assistant` plugin rather than core, because
it is the one AI surface that spends your money on behalf of anonymous
strangers — that should be a deliberate decision with a switch. Enable it, write
your house rules into **Guardrails**, list the origins allowed to embed it, and
add one line to your layout:

```html
<script src="https://cms.yoursite.com/ext/assistant/widget.js" defer></script>
```

That is the whole integration — a bubble drawn inside a shadow root, so it cannot
collide with your CSS and your CSS cannot reach it. It borrows the provider you
already connected, answers from published content only, grounds itself in the
page the reader is on, and returns a line you wrote rather than guessing when the
answer is not there. With no origins listed it answers nobody, which is the
default. If you would rather draw your own, `POST /ext/assistant/public-ask`
returns the same answer as JSON.

### An agent working the site from outside

Inky is for the person at the admin. For a coding agent in a terminal somewhere
else, `bun run mcp` serves the admin API as MCP tools over stdio — entries,
content types, media, menus, settings, taxonomy, search, and revisions.

It signs in with an **agent key**, not your password. Mint one under **Agent
keys** in the admin, ticking only what that agent needs:

```json
{
  "mcpServers": {
    "mysite": {
      "command": "bun",
      "args": ["run", "/path/to/inkling/scripts/mcp.ts"],
      "env": {
        "INKLING_URL": "https://cms.yoursite.com",
        "INKLING_KEY": "inkagt_…"
      }
    }
  }
}
```

A key acts as the account that minted it, but only for the boxes you ticked,
only until it expires, and you can revoke it on its own without changing your
password or signing anyone out. It can never do anything administrative —
adding a user, minting an API key, connecting a social account, installing a
plugin — whatever you tick and whatever role you hold. Demote the account and
every key it minted narrows with it, immediately.

That is enforced by Inkling, not by the tool list. The MCP server reads its own
grants at startup and offers only the tools they cover, so the model does not
plan around a call that would be refused — but the refusal happens at the site.

One process per site, because keys are per-site. Every write goes through the
same `/api` route the admin calls, so revisions, validation, hooks, and the audit
trail keep working; the history shows the account, and records which key acted.
`INKLING_MCP_READONLY=1` narrows further than the key does, for pointing an agent
at production to look rather than touch without minting a second key.
The [agent operations guide](https://wess.io/inkling/agent-guide.md) covers
discovery order, production safety, failure handling, and reliable update
workflows.

## Social

Inkling posts to **X, Facebook, Instagram, Threads, LinkedIn, TikTok, YouTube,
Pinterest, and Google Business**. Set a network up under Social → Settings,
connect an account under Social → Accounts, write a post, aim it at one network
or all nine, and send it now or at a time.

Each network gets the same caption unless you give it its own — X's 280
characters and a YouTube description are not the same piece of writing, and the
composer counts both as you type. Media comes from the library everything else
uses. Everything a network will refuse is checked when you save rather than when
it sends, because a scheduled post that turns out to be unpostable at 6am on a
Saturday is a notification nobody reads.

**A post's outcome is per network.** Sending records what each one did on its own
row, with that network's own error next to it — so a post X took and TikTok
refused reads as *part posted*, not as a success or a failure. Press send again
and only the failures are retried; what already went out is never posted twice.

For agency workflows, the optional `social` plugin adds client and campaign
planning around these core posts. A plan links to one core post through
`publishPostId`; delivery, retries, per-network outcomes, and error state stay
owned by core, while the plan mirrors the result.

Three roles, because sending is irreversible in a way publishing a page is not:
an author writes a post, an editor decides when it goes out, an admin connects
the accounts.

Each network needs a developer app registered with *that network* against a
redirect URI on your domain — there is nothing self-hosted software can ship
instead. **Social → Settings** is where that goes: a row per network with a
client id, a sealed secret, an on/off switch, and a **"?"** that opens a plain
walkthrough of that network's console — what the buttons are actually called,
how long it really takes including the waiting, and the one step everybody gets
wrong. Networks are independent, so the ones you have finished work while the
rest are still in review.

`SOCIAL_OAUTH_<NETWORK>_CLIENT_ID` and `_CLIENT_SECRET` still work and are read
for any network you have not set up in the admin.

Five of the nine — Facebook, Instagram, Threads, Pinterest, Google Business —
download media from your site rather than being handed it, so posts carrying
images or video need `PUBLIC_URL` to be an address they can reach. The settings
screen says so if it is not.

## Plugins

Drop a directory into `plugins/` and enable it in the admin. Eight ship with it:

| Plugin | Demonstrates |
|---|---|
| `seo` | A `delivery.entry` filter adding computed metadata to every response |
| `redirects` | A plugin-owned content type plus a public lookup route |
| `forms` | A plugin with its own table via plugin-scoped migrations |
| `commerce` | Content type + taxonomy + settings + a convenience route |
| `analytics` | Cookieless traffic collection, and a `stats` panel that renders as a dashboard |
| `assistant` | A public, page-aware assistant answering from published content only |
| `social` | Agency social planning — clients, campaigns, a queue, a calendar, performance reporting, and a link from each plan to its core delivery post |
| `google` | Google Analytics and Google Ads. A `guide` panel that walks a non-technical operator through setup and ticks itself off as they go, two `stats` panels, and a `secret` setting whose value the API can never hand back |

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

Nothing about this dictates how your site is built. The sites running on Inkling
today take every word, product, and image from the delivery API while their
markup and CSS stay entirely hand-written.

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
bun add github:wess/inkling#v1.10.0   # pin to a release
bun add github:wess/inkling          # or follow main
```

Pin a site you care about. The unpinned form resolves to whatever `main` is at
install time, which is right for trying it and wrong for a site in production.

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
  // The request-body ceiling and idle timeout. Bun buffers a whole body before
  // any handler runs and defaults to 128MB, so spreading this is not optional.
  ...inkling.serveOptions,
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
| `bun run docs` | Validate every documentation page, local link, and anchor |
| `bun run password` | Set a user's password from the host — the way back in when the only owner is locked out |
| `bun run mcp` | The admin API as MCP tools, for an agent working a site from outside it |

Postgres tests run automatically when a Postgres is reachable at
`TEST_POSTGRES_URL` (default `postgres://postgres:postgres@localhost:5432/inkling_test`)
and skip otherwise, so `bun test` stays zero-setup.

## Documentation

- **[wess.io/inkling](https://wess.io/inkling/)** — the GitHub Pages site
  - [Get set up](https://wess.io/inkling/start/) — empty database to a live site
  - [Guide](https://wess.io/inkling/guide/) — the model, delivery, realtime,
    previews, AI, plugins, and running more than one site
  - [Tutorials](https://wess.io/inkling/tutorials/) — a blog end to end, writing
    a plugin, multiple sites, embedding, and connecting an external agent
  - [Reference](https://wess.io/inkling/reference/) — every route, field type,
    variable, and command
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module layout, data model,
  plugin system, realtime, previews, AI, and the dialect-portability rules
- [`llms.txt`](https://wess.io/inkling/llms.txt) — the small machine-readable map
  agents can use to choose only the context they need
- [Agent operations](https://wess.io/inkling/agent-guide.md) and
  [delivery API](https://wess.io/inkling/delivery.md) — focused Markdown guides
  without page chrome
- [`llms-full.txt`](https://wess.io/inkling/llms-full.txt) — product and codebase
  context for work that spans more than one focused guide
- [`.env.example`](.env.example) — every configuration variable

`docs/` is the site. Anything committed there publishes to the `gh-pages` branch
on push (`.github/workflows/pages.yml`), so `llms.txt` lands at the site root
where agents look for it.

## Releases

Sites install Inkling from GitHub and pin it by tag; nothing is published to
npm. [`CHANGELOG.md`](CHANGELOG.md) is written for the one person who needs it —
someone deciding whether to move a site from one tag to the next.
[`RELEASING.md`](RELEASING.md) is how a release is cut and how it reaches a site.

## License

MIT. See [`LICENSE`](LICENSE).
