# Architecture

Inkling is a headless CMS: a content API plus an admin SPA, extended by
plugins. It stores content, and websites read it over an HTTP delivery API.
It does not render your site.

```
                     one process, one port :4300
   ┌───────────────────────────────────────────────────────┐
   │  src/server.ts                                        │
   │                                                       │
   │   /api/…      session      ─┐                         │
   │   /content    api key       │                         ├──▶ Postgres
   │   /preview    token         ├─ router                 ├──▶ blob storage
   │   /media/file public        │                         ├──▶ AI provider
   │   /ext/…      plugins      ─┘                         │    (optional)
   │   /realtime   websocket                               │
   │                                                       │
   │   anything else ─────────▶ the admin (Bun.build)      │
   └───────────────────────────────────────────────────────┘
             ▲                            ▲
      your website                    your team
     (delivery key)                (session + socket)
```

## Two audiences, two surfaces

| | Admin API | Delivery API |
|---|---|---|
| Auth | session JWT (`Authorization: Bearer`) | API key (`X-Api-Key`) |
| Access | everything, role-gated | published content only, read-only |
| Routes | `/api/auth`, `/api/types`, `/api/entries`, … | `/content/*`, `/site/*` |
| Consumers | the admin | your websites |

They share one origin and are separated by path. Everything session-gated is
mounted through `prefixed("/api", …)`; everything public keeps a root path,
because those paths are pasted into other people's code — a media URL is stored
in a row, a preview link is sent to a stakeholder, `/content` is integrated once
and left alone. Whatever the router does not claim is the admin, which is why
`/settings` can be a screen while `/api/settings` is the API.

Mounting is by *audience*, not by module: a feature with both kinds of route
exports two arrays (`mediaRoutes` / `mediaFileRoutes`) rather than being mounted
twice under different prefixes.

There are two deliberate exceptions to "published only", each narrow enough to
state in a sentence. A **preview token** (`/preview/:token`) names one entry,
expires within the hour, and is signed rather than stored — it is how a draft
reaches someone without an account. The **realtime socket** (`/realtime`) tells a
key holder that published content moved, carrying ids and never payloads.

A delivery key can never see a draft, a user's email, or a soft-deleted row.
Referenced entries are re-checked for `published` status and the delivery key's
content-type scopes during expansion, so a reference cannot leak a draft or
content outside the key's allowlist. Delivery responses are private-cacheable
and vary on the credentials that shape them.

## Composition root

Assembly and port ownership are two files, because they have two different
lifetimes. `src/app.ts` builds Inkling and returns it; `src/server.ts` is the
twenty lines that give it a port. A host process that already owns `:443` takes
the first and skips the second.

`createInkling(options)` in `src/app.ts`, in order:

1. Refuse to start if `NODE_ENV=production` and `SECRET` is still the default or
   under 32 characters — the one check that runs before anything touches disk
2. Run migrations (`src/migrate`)
3. Bootstrap the first owner from `BOOTSTRAP_*` when supplied. Otherwise the
   one-time `/auth/setup` flow lets the first admin visit claim an empty site;
   it closes permanently as soon as an owner exists
4. Build the storage driver and the hook bus; bridge core hooks → webhooks and
   → the realtime socket
5. Load plugins in dependency order, auto-enabling `PLUGIN_AUTOENABLE` on a
   fresh install
6. Assemble routes from feature factories
7. Start background sweeps (`setInterval`): scheduled publishing every 60s,
   rate-limit cleanup hourly
8. Bundle the admin and return `{ fetch, upgrade, websocket, siteKey, db, config, stop }`

`src/server.ts` then wraps that in `Bun.serve` and `withSecurityHeaders`, with a
`fetch` that attempts the WebSocket upgrade first — once anything returns a
`Response` the handshake is gone.

Each feature is `src/<feature>/index.ts` exporting a route factory. Signatures
vary by dependency: `authRoutes(db)`, `entryRoutes(db, hooks)`,
`mediaRoutes(db, store, hooks)`, `pluginRoutes(db, hooks, registry, dir)`.

Migrations and plugins ship *with* the package, so `createInkling` resolves both
against the module's own directory rather than the working directory. Standalone
they are the same place; embedded they are not, and a cwd-relative default would
send Inkling looking for the host application's `./plugins`.

### Embedding

`package.json` exports `.` → `src/app.ts` and `./server` → `src/server.ts`, so a
site can mount its own CMS instead of deploying one beside itself:

```ts
import { createInkling } from "inkling"

const inkling = await createInkling({ adminBase: "/admin", siteKeyName: "site" })

Bun.serve({
  // Body ceiling and idle timeout, decided by Inkling so a host cannot drift.
  ...inkling.serveOptions,
  fetch: async (request, server) => {
    // Before anything returns a Response, or the handshake is gone.
    if (request.headers.get("upgrade") === "websocket") {
      if (inkling.upgrade(request, server)) return undefined as unknown as Response
    }
    // Pass `server` — it is where the real socket peer comes from.
    return (await inkling.fetch(request, server)) ?? myOwnRouter(request)
  },
  websocket: inkling.websocket,
})
```

Two option shapes carry the weight. **`adminBase`** decides what happens to a
path no Inkling route claimed: at `"/"` — the standalone spelling — every
unmatched path becomes the admin, which is why `src/server.ts` needs no fallback
of its own. Anything else confines the admin to that prefix and `fetch` returns
**`null`** off it, so the host keeps routing. That `null` is the whole embedding
contract: Inkling never swallows a path it does not own.

**`siteKeyName`** mints a delivery key for a consumer sharing the process, since
an in-process site has no browser in which to visit the admin and copy one. It is
*derived* from `SECRET` and the name rather than randomly generated, so the same
name yields the same key on every boot — the row is replaced when it is missing,
stale after a `SECRET` rotation, or revoked. Rotating `SECRET` rotates this key
along with sessions and stored AI credentials.

**`serveOptions`** exists so two `Bun.serve` values are Inkling's decision rather
than a host's to remember. `maxRequestBodySize` is the load-bearing one: Bun
buffers a whole request body before any handler runs and defaults to 128MB,
`parseJson` calls `request.json()` on whatever arrived, and the upload limit in
`src/media` is checked only *after* multipart has been parsed into memory — so
the socket is the only place a ceiling costs nothing. It carries headroom over
`MAX_UPLOAD_BYTES` for multipart framing. `idleTimeout` rides along because it
was missing from this snippet until they were bundled together — which is the
argument for bundling them.

One thing is still the host's to get right, and it fails silently.
**Pass `server` through to `fetch`.** `withSecurityHeaders` is applied inside
`createInkling` rather than by the port owner, precisely so an embedding host
cannot forget it: the wrapper is also what stashes the socket peer on the request
for `src/security#clientIp` to read. Without a peer, `clientIp` returns an empty
string, every rate-limit bucket keys on it, and the per-IP login limit silently
becomes one global bucket shared by every account on the instance. Headers are
only filled in when absent, so a host's own — and a route's, like media's
`cross-origin` — still win.

### One instance per process

`config` and `db` are module-level singletons — `src/db/index.ts` opens the
connection at import time from `DATABASE_URL`. Calling `createInkling` twice in
one process therefore yields two route sets over **the same database and the same
configuration**, which is not a second site. The options that exist are the ones
that can vary without a second config: where the admin answers, and where
migrations and plugins are read from.

So a second site is a second process. See "Running more than one site" below for
what that means in practice.

## Running more than one site

Inkling is single-tenant, and the schema says so in three places rather than one:

| | |
|---|---|
| `settings` | `scope` is `'site'` for core keys, the plugin name for plugin-owned ones. There is one `'site'` scope per database |
| `menus` | `name` is globally `UNIQUE` — one menu namespace per database |
| `PUBLIC_URL` | One origin per process. Local-driver media is stored root-relative and resolved against it at read time |

A delivery key's `scopes` partitions **content types** and nothing else. That is
genuinely useful — one instance can serve several sites that share an editorial
team and a content model, each key seeing only its own types — but settings,
menus, media URLs, and the user list stay common to all of them.

**The supported shape for separate sites is a database per site.** Three sites is
three `DATABASE_URL`s: three processes standalone, or three hosts each calling
`createInkling`. They can share a Postgres server and a bucket; what they must
not share is a schema.

Run one instance for several sites only when they are genuinely one property —
the same team, one set of site settings, one menu namespace — and use scoped keys
to keep each site reading its own types.

## Dialect portability

Postgres is the store. The SQLite driver remains wired up because the test
suite runs against it in memory — which keeps `bun test` free of setup, and
keeps a second dialect exercising the schema.

That second dialect is why the column choices below look conservative: every
type round-trips to the same JS value on both drivers, so a row read in a test
has the same shape as a row read in production.

| Concept | Column | Why not the obvious choice |
|---|---|---|
| Primary key | `TEXT` uuid | `SERIAL` vs `INTEGER PRIMARY KEY AUTOINCREMENT` aren't portable. UUIDs also let content move between environments without renumbering foreign keys. |
| Timestamp | `TEXT` ISO-8601 | Postgres `TIMESTAMPTZ` returns a `Date`; SQLite returns a string. ISO text also makes lexical sort equal chronological sort. |
| Boolean | `INTEGER` 0/1 | Postgres `BOOLEAN` returns `true/false`; SQLite returns `0/1`. |
| JSON | `TEXT` | Postgres `JSONB` arrives pre-parsed; SQLite doesn't. |
| Column names | snake_case | `atlas/db` emits identifiers **unquoted**. Postgres folds camelCase to lowercase, SQLite preserves it — so a camelCase column returns a differently-spelled key per driver. |

The two places dialects genuinely differ are isolated in `src/db/dialect.ts`:
`contains()` picks `ILIKE` vs `LOWER(...) LIKE`, and `countRows()` normalizes
Postgres's BIGINT `COUNT` (which may arrive as a string).

SQLite connections enable foreign-key enforcement when opened. Each migration
runs in a transaction, including its `schema_migrations` record, so a partial
file is rolled back rather than being recorded as applied.

`tests/postgres.test.ts` exercises this against a real Postgres when one is
reachable, and skips otherwise so the default `bun test` needs no setup.

### The migration runner

`src/migrate/index.ts` replaces `atlas/migrate#up`, which hands a whole
`up.sql` to `db.execute` as a single statement — and bun:sqlite's
`prepare(sql).run()` executes only the *first* statement of a multi-statement
string while reporting success. Ours splits on statement-terminating semicolons
(respecting quoted strings, `--` and `/* */` comments, and `$$` dollar-quoting)
and executes each file transactionally. It also namespaces plugin migrations in
`schema_migrations` as `plugin:<name>/<migration>`.

## Data model

18 core tables. The spine is `content_types` → `entries` → `revisions`, with
`media`, `taxonomies`/`terms`/`entry_terms`, `menus`, `settings`, `api_keys`,
`agent_keys`, `webhooks`, `plugins`, `users`/`sessions`, `ai_credentials`, and
`audit_events`/`rate_limits`.

**Content types** are user-defined shapes. `fields` holds an ordered array of
field definitions as JSON; `kind` is `collection` (many entries) or `single`
(exactly one — a homepage, site hours). `owner_plugin` marks a type a plugin
declared, which makes it read-only in the UI and lets disabling the plugin
retire it. `preview_url` is an optional site-relative or absolute template;
`{slug}`, `{id}`, `{locale}`, and `{type}` let the admin open a published entry
on the consuming site without guessing its routing convention.

**Entries** carry `title`, `slug`, `status`, `locale`, and a `data` JSON blob
validated against the type's fields. Statuses: `draft`, `review`, `scheduled`,
`published`, `archived`. Every save snapshots the *pre-edit* state into
`revisions`, so restoring a revision restores what it replaced.

Slug uniqueness is per `(content_type_id, locale)` and ignores soft-deleted
rows, so restoring from trash never collides. It is enforced in `src/entries`
rather than by a unique index, because partial indexes aren't portable.

**Soft deletion**: `entries`, `media`, and `users` carry `deleted_at`. All list
and read queries filter `deleted_at IS NULL`. The admin exposes a trash screen
for restoring entries and media. Purging an entry transactionally removes its
revisions first; purging media removes its blob after the row is gone, tolerating
a storage failure rather than reporting that the database delete failed.

## Fields

`src/fields/index.ts` is the single registry of field types — how each
validates, what its empty value is, and what the SPA renders. 18 types
including `list` (a nested, recursively-validated repeater), `media`/`gallery`
(media ids), and `reference` (entry ids).

Validation merges submitted values over stored ones, so a partial save from the
editor never blanks a field it didn't render. Errors come back as
`{ code: "VALIDATION_FAILED", details: { fields: [{ key, message }] } }` so the
editor can mark specific inputs.

Field definitions are validated when a content type is saved, not at every
entry write — a bad schema is rejected at author time. Publishing and revision
restore revalidate the stored data against the current schema, so an older draft
cannot bypass a newly-required field. A scheduled entry is revalidated when
its time arrives; if its model or relations changed in the meantime it moves
to review instead of publishing broken data.

Media and reference ids are checked against live rows and reference fields also
enforce their declared target content type. Deleting media or an entry is
refused while active content points to it; media used by site-level logo,
favicon, or social-image settings is protected the same way. Deleting a content
type is also refused while another model references it.

## Delivery API

`GET /content/:type` and `/content/:type/:slug` return published entries with:

- **media and reference fields expanded** into full objects, so a site renders
  an entry without a request per image
- **terms attached** when `?include=terms`
- a final pass through the `delivery.entry` **filter**, letting plugins reshape
  the payload

Media URLs are stored root-relative and resolved against `PUBLIC_URL` at read
time, so changing hostname doesn't require rewriting rows. Media responses set
`Cross-Origin-Resource-Policy: cross-origin` — without it, `withSecurityHeaders`
would default to `same-site` and every `<img>` on a consuming site would fail
silently.

`GET /content` lists the types a key may read, with their field shapes, so a
consumer can discover the model.

`?term=<slug>` filters by taxonomy term through a **join** on `entry_terms`, not
by collecting ids into an `IN (…)` list. One bound parameter per tagged entry
means a term applied to enough content eventually exceeds the driver's parameter
ceiling and the query fails outright rather than merely slowing down.

## Realtime

`src/realtime` adds one WebSocket per client at `/realtime`. It exists because
the admin showed stale lists whenever two people worked at once, and because a
consuming site had no way to learn that published content changed short of
polling on a timer.

**The socket grants no authority the HTTP surface doesn't.** A session sees what
its role already permits; a delivery key hears only that published content moved,
filtered by the same scopes `/content` applies. Payloads never carry an entry's
`data` — a frame says *what* changed and the consumer re-reads it through the API,
where the boundary is enforced on the way out.

**Tickets, not tokens in URLs.** A browser cannot set headers on a WebSocket
handshake, which leaves the query string — and query strings land in access logs.
So `POST /realtime/ticket` (session) or `POST /realtime/delivery/ticket` (key)
mints a single-use ticket valid for 30 seconds, and the socket is opened with
that. Leaking one buys nothing. The store is in memory on purpose: the value is
worthless by the time anything could read it, and a multi-process deployment
needs sticky routing for the upgrade regardless.

Three topic shapes: `site`, `content:<type>`, and `entry:<id>`. Entry topics also
carry **presence**, so the editor can show who else is looking at a record. A
delivery key is refused entry topics entirely — activity on one record is
editorial signal about work that may still be a draft.

## Previews

A content type can declare a `preview_url` template, but until there was a way to
*fetch* an unpublished entry the template had nothing to point at. `POST
/entries/:id/preview` mints a signed token naming exactly one entry, good for an
hour; `GET /preview/:token` returns that entry whatever its status, with media
expanded and `X-Robots-Tag: noindex`.

Signed rather than stored, because the value of a preview link is that it can be
pasted to someone with no account, and a row per share is bookkeeping for
something meant to be disposable. Nothing is revocable, which is why the lifetime
is short. References are *not* expanded: that would mean deciding whether a
referenced draft is also in scope, and one token should mean one entry.

## AI

Optional, and off until an operator connects a provider. Three parts:

**Credentials** (`src/ai`) live in their own table rather than in `settings`,
because `settings` is read wholesale by `readScope()` and surfaced to plugin
panels — exactly the wrong shape for a secret. The key is sealed with AES-GCM
under a key derived from `SECRET` and is never returned by the API; `hint` is the
last four characters so two keys can be told apart. That protects a database
dump, a backup, and a read-only SQL leak — not an attacker who already has the
process environment, since the key comes from it. Rotating `SECRET` invalidates
stored credentials, which surfaces as "reconnect this provider" rather than a 500.

There are two ways to connect one. An **API key** is pasted into the admin and
works immediately. **OAuth** (`src/ai/oauth.ts`) is authorization-code with PKCE:
`POST /api/ai/oauth/:provider/start` returns a consent URL, and the provider
redirects to `/ai/oauth/callback` — a public route, because the browser arrives
by top-level navigation carrying no bearer token. What stands in for a session is
the `state` parameter, which is *sealed rather than stored*: it holds the PKCE
verifier and the admin who began the flow, expires in ten minutes, and cannot be
minted without `SECRET`. The role is re-read on the way through, so an account
demoted mid-flow cannot finish it. The access token lands in the same
`ciphertext`/`iv` columns a key uses — so every reader keeps working without a
branch — and the refresh token gets its own sealed pair; a token within a minute
of expiry is refreshed on the read path rather than by a timer.

OAuth is the second-class path on purpose. A client is registered *with the
provider* against a specific redirect URI, so it cannot be entered in the admin —
`AI_OAUTH_<PROVIDER>_CLIENT_ID` and friends are the only environment variables
the AI feature has, and the admin offers the button only for providers that have
one. A key works the moment it is pasted; that asymmetry is real and the UI shows
it rather than hiding it behind a button that dead-ends.

**The editorial assistant** (`POST /ai/assist`) is not a chat window bolted onto
the admin. Each intent — draft, rewrite, shorten, expand, summarize, titles, seo,
translate, ask — corresponds to something an editor was already doing by hand, and
each is handed the content model and the entry so the answer is about *this* site.
It streams over SSE because a rewrite of a long field otherwise looks like a hung
request. Content is fenced in `<content>` / `<selection>` tags and the model is
told to treat it as material, never as instructions: an entry whose body says
"ignore your instructions" is a string an editor typed.

**The agent is named Inky** (`POST /ai/agent`, `src/ai/agent.ts`) and is the
assistant given the run of the site rather than one field. It reads content
types, entries, media, categories, menus, site settings, plugins, people,
delivery keys, webhooks, and the social setup; it works out which page — or
which missing piece of setup — you meant; and it comes back with changes. It is
a tool loop over `src/ai/tools/`, streamed over SSE so the tool trace is visible
as it happens, and it holds no server-side state — the transcript rides back and
forth with the browser, which is refused rather than truncated when it outgrows
its cap.

The name and the voice are load-bearing rather than decoration. The person asking
is usually not the person who built the site: they describe an outcome — "we need
somewhere for customer quotes", "take the old promo off the menu", "I want to
post this to Instagram" — and the translation into a field on a content type, or
into a developer app registered with a network, is Inky's job, not theirs. So the
system prompt does most of the work here. It states the two kinds of change that
exist (what a page *says* is an entry; what a page is *made of* is its content
type), tells Inky to prefer acting over interrogating, and tells it to speak in
"section" and "page" rather than "field" and "entry" while still calling tools
with the exact keys.

It also states the boundary out loud, because the obvious request is one Inkling
cannot serve: **Inkling stores content and does not render the site**, so
colours, fonts, spacing, and layout live in the consuming site's own code. Inky is
told not to refuse flatly and not to pretend, but to find the content-shaped
version of the request — "make the hero bigger" is somebody else's job, "make the
hero say less" is usually what was meant — and to name the rest as belonging to
whoever builds the site.

**Every tool in that surface is a read.** The agent cannot write, and no flag
makes it able to: every `propose_*` tool records an intention and hands it to the
admin, which renders a diff and applies it by sending the change through the
ordinary admin route — `PUT /api/entries/:id` for an entry, and its own route for
each of the rest. That keeps one write path in the codebase, so revisions, field
validation, slug uniqueness, relation checks, hooks, and the audit trail all keep
working without a second implementation to keep honest, and the history names the
person who approved the change rather than a machine nobody can ask about it.
`tests/aiagent.test.ts` asserts the tool list contains nothing but reads,
proposals, and the one navigation tool, because a write tool added later would
otherwise fail silently — the first sign would be a published page changing by
itself.

A tool is its schema and its handler in one object (`src/ai/tools/common.ts#Tool`),
grouped by area across `content.ts`, `site.ts`, `access.ts`, and `social.ts`. The
two halves drifted apart when they lived in a spec list and a `switch`, which is
the argument for the shape.

**The tool list is filtered by the asker's role**, and that is a correctness
property rather than a courtesy. Each tool declares the capability its proposal
will need at apply time; `toolsFor(role)` drops the ones the person could not
apply, and `runTool` refuses a call the model invented anyway. Without it an
author would be shown `propose_settings_update`, confidently queue a rename, and
meet a 403 on the button — which reads as a bug rather than as a rule. Each
proposal also carries the scope it needs, and `POST /ai/agent/status` returns the
scopes the account holds (`scopesFor` in `src/auth/roles.ts`), so the panel greys
one card rather than the whole tray and never keeps a second copy of the role
ladder in the browser.

**One tool is neither a read nor a proposal.** `open_screen` moves the admin, and
it happens as it is announced rather than waiting for a button — `go()` in the
SPA already asks about unsaved work, so it is the only mover. It exists because
four things genuinely need hands: uploading a file, creating an account (a
password has to be typed), pressing Connect on a social network (a consent screen
on the network's own domain), and pasting a client secret. For those the honest
answer is not a sentence naming a screen; it is being on it. The screen names are
enumerated in `src/ai/tools/index.ts` and mirrored by `routeFor` in the admin, so
a screen the model invents is refused rather than routed to a blank page.

**Setting things up is half of what Inky is asked**, and the social networks are
the hard case: posting needs a developer app registered with the network, its
client ID and secret saved here, and then an account connected — three states,
and the usual answer is that one of them is missing. `get_social_setup` reports
all three per network with the exact redirect URI; `get_social_guide` hands over
the register in `src/social/guides.ts` — the real button names, the honest
timings, and the one step everybody gets wrong — so Inky can walk somebody
through a console a step at a time instead of the operator reading prose alone.
Inky is told to ask for a client ID in conversation but never for a **secret**:
it is a password, and a chat window sends it further than it needs to go. The
tool accepts one if it is already in the transcript, because refusing it then
protects nothing, and the admin masks it in the diff.

Two proposals hand back something that exists exactly once — a delivery key and a
webhook's signing secret — so applying either opens the same "copy this now"
modal the Keys screen uses.

Inky runs on any of the three providers, because all three can call tools. What
differs is the wire format, and there are only two: Claude's own, through the
official SDK, and OpenAI's, through `atlas/ai`. **Ollama takes the OpenAI path**
— it serves an OpenAI-compatible endpoint at `/v1` both locally and as Ollama
Cloud, so the difference between the two is a base URL. Going through `atlas/ai`'s
*native* Ollama provider would not work: it drops tools when streaming and sends
no `Authorization` header, which puts the cloud out of reach entirely.

The two loops are deliberately not merged. They agree on the tool list, the
proposals, and the frames the browser receives, and disagree about message shape,
streaming events, and where the system prompt goes — one loop branching at each
of those points read worse than two that each tell one story.

Two consequences worth stating. The transcript the browser holds is
provider-shaped, so `role: "tool"` is accepted alongside `user` and `assistant`
— OpenAI carries tool results as their own messages where Claude nests them in a
user turn. `system` stays refused on both, because the instructions are ours to
set and a transcript that could carry one would be a way to replace them from the
browser; on the OpenAI path the system prompt is therefore prepended per request
rather than kept in the transcript.

Ollama is also why `needsKey` and `acceptsKey` are two questions rather than one.
A local instance authenticates by not being exposed; Ollama Cloud needs a key
like anything else. One flag could express only one of them.

**The prefix is cached, and the bookkeeping is the interesting part.** Inky's
tool definitions and system prompt are identical on every call, and one question
makes up to twelve of them — so uncached, the same few thousand tokens are bought
back a dozen times per question. Render order is tools → system → messages, so a
single breakpoint on the system block covers the whole stable prefix.

One breakpoint is not enough. A breakpoint searches back at most twenty content
blocks for a prior entry, and a single step can add more than that on its own —
a parallel round of tool calls is an assistant message of `tool_use` blocks plus
a user message of `tool_result` blocks. A marker fixed to the system prompt
therefore stops being found partway through a long run. Two more ride the newest
turns, oldest retired as a third arrives, which keeps an anchor inside the window
while the newest is still being written and stays under the four the API allows.

The transcript round-trips through the browser, so it comes back carrying the
last turn's markers; they are cleared before the next run rolls its own. Left in
place they accumulate across turns until a request is rejected — a failure that
would only appear on a conversation someone kept going.
`tests/aicache.test.ts` drives the real route against a mock that speaks the SSE
dialect, because the bookkeeping being right says nothing about whether the
markers reach the wire.

Nothing equivalent happens on the OpenAI path: OpenAI caches long prefixes
server-side without being asked, and Ollama has no such notion.

Content the agent reads is fenced and declared to be material, the same way the
assistant fences it.

**The public assistant** is the `assistant` plugin, not core — it is the one AI
surface that spends the operator's money on behalf of anonymous visitors, so it
should be a deliberate decision with a switch to turn it back off, which is what
enabling a plugin is. It answers from published content only, grounded in the page
the visitor is on, and returns a configured line rather than guessing when the
answer isn't there.

Claude is the default and goes through the official Anthropic SDK. Other providers
go through `atlas/ai`'s abstraction rather than being bent into an
Anthropic-shaped client.

## Plugins

A plugin is a plain object at `plugins/<name>/index.ts`:

```ts
export default definePlugin({
  name: "commerce",           // must match the directory
  version: "1.0.0",
  requires: [],               // other plugins, enabled first
  contentTypes: [...],        // upserted on enable, owned by this plugin
  taxonomies: [...],
  settings: [...],            // namespaced in `settings` under scope = name
  panels: [...],              // declarative admin UI
  routes: ctx => [...],       // mounted at /ext/<name>/…
  register: ctx => {...},     // attach hooks
  install: ctx => {...},      // once per version — the upgrade hook
  uninstall: ctx => {...},
})
```

**Loading.** The registry scans `PLUGIN_DIR`, imports each `index.ts`, and
validates the manifest. A plugin that throws on import is recorded with its
error and shown as broken in the admin rather than taking the server down.
Enable resolves `requires` depth-first; disable refuses while a dependent is
still on.

**Routes without restarts.** Plugin routes are declared relative and prefixed to
`/ext/<name>` by the registry. `pluginDispatch` mounts one wildcard per method
and resolves against the registry's *current* route list per request, so
toggling a plugin takes effect immediately. `/ext` is deliberately separate from
`/plugins` (the management API) so a plugin route can never shadow
`POST /plugins/:name/enable`.

**Hooks.** Two kinds, and the distinction is the safety model:

- `emit` — notification. Every listener runs; failures are isolated and logged.
  A plugin can observe anything without being able to break it.
- `filter` — transformation. Listeners chain in order. A throwing filter is
  skipped and its input carries forward, so a broken plugin degrades to a no-op
  instead of blocking a save or blanking the delivery API.

**Isolation.** A plugin's settings live under its own scope, its migrations are
namespaced, its content types are tagged with `owner_plugin`, and its routes are
confined to `/ext/<name>`. `uninstall` rolls all of that back; `disable` is the
reversible option and leaves data intact.

**Admin UI is declarative.** The SPA is bundled ahead of time, so a plugin
cannot inject React into it. Instead it describes panels that the SPA already
knows how to render — which is what makes a plugin installable without a
rebuild. Five kinds: `settings`, `collection`, `table` (an endpoint plus
columns), `stats`, and `connections`.

A `stats` panel is a plugin's dashboard. Its endpoint returns a `PluginStats`
payload — tiles, one series, and any number of top-N tables — and the SPA lays
out what it is handed. The plugin does all the aggregating *and* the formatting,
including thousands separators and rounding, so a panel never has to guess what
a number means. `ranges` adds a day-window switch that re-requests with `?days=`.

Bundled: `seo` (delivery filter), `redirects` (plugin-owned type + public
route), `forms` (own table via plugin migrations), `commerce` (types +
taxonomy + settings + route), `analytics` (own table + public write route +
A `connections` panel is a list of things that can be authorized. Its endpoint
returns a `PluginConnections` payload; the SPA owns exactly three verbs —
`POST <endpoint>/<id>/start` for a consent URL, the return leg, and
`DELETE <endpoint>/<connection id>` — and every word on a row comes from the
plugin, because only the plugin knows what it is connecting to. A row renders in
one of three states: no client registered, registered but unconnected, or
connected (with the account name and, when a refresh has failed, the provider's
own words). `ctx.adminBase` exists for this and only this: the return leg is a
top-level navigation and has to land somewhere in the admin.

Bundled: `seo` (delivery filter), `redirects` (plugin-owned type + public
route), `forms` (own table via plugin migrations), `commerce` (types +
taxonomy + settings + route), `analytics` (own table + public write route +
`stats` panel), `assistant` (public AI answers grounded in published content),
`social` (four types, an `entry.beforeSave` filter, two `stats` panels, and a
`connections` panel).

### Social (the plugin)

`social` is the agency layer *above* posting: what was sold to a client, and
whether it happened. Connecting accounts and sending to a network are core (see
"Social" below), and moved there when they needed a composer and a background
sweep — a plugin can ship neither.
Clients, channels, campaigns, and posts are ordinary content types, so the
composer, revisions, search, and trash come for free; the plugin's own code is
almost entirely *readings* of those entries — `plugins/social/queue.ts` (what is
not yet posted, soonest first), `week.ts` (a calendar drawn as one `stats` table
per day, because a plugin cannot ship React into a bundle built before it
existed), and `report.ts` (cadence against what was sold, then what the posts
did).

The one thing an entry cannot hold is a time series that keeps arriving after
the document stops changing, so results live in `social_results` — one row per
day, network, post, and channel, replaced rather than appended when the same day
is reported twice. `POST /ext/social/results` takes them with a delivery key,
the same shape of trust as a form submission.

Workflow lives in a `stage` field rather than the entry's own `status`: an entry
is published when the plan is visible, which is a different question from
whether the post has gone out. An `entry.beforeSave` filter tidies hashtags,
fills in default networks, and stamps the approval — a filter rather than a
hook, so a failure there leaves the editor's own values instead of failing the
save. It runs after validation, so everything it writes has to already be legal
for its field.

A `socialpost` here is a *commitment* — approved on a date, counted against a
contract — and its `stage` records what happened to it. A post in the Social
section is a thing that gets sent. An agency uses both; a solo operator only
ever needs the second.

### Analytics

`analytics` collects traffic without cookies and without storing an address. A
site posts a beacon to `/ext/analytics/collect` with a delivery key, exactly as
it posts a form submission; reading the numbers back needs a session.

What is stored is what survives `plugins/analytics/ingest.ts`: the path without
its query string, the referrer reduced to a host, and a `visitor` hash salted
with `SECRET` **and the current date**. The date in the salt is the privacy
model — the hash counts uniques within a day and is uncorrelatable across days,
so there is nothing to consent to and nothing to expire.

Because a consuming site proxies its visitors' beacons, the socket peer is that
site's server and every visitor would otherwise hash identically. `collect`
therefore accepts `ip` and `ua` in the body from a key holder, which is trusted
because a delivery key is a server-side secret. Both are hash inputs only.

Rows carry a denormalized `day`, since extracting a date from a timestamp is
spelled differently per dialect and every report here groups by it. Retention
runs from the first beacon of each new day rather than a timer — a plugin that
installs its own `setInterval` keeps running after it is disabled.

## Social

`src/social` is the marketing half of the product: connect an account, write a
post, aim it at one network or four, and send it now or at a time. It is core
rather than a plugin, and the two reasons are the two things it needs.

The first is a **background sweep**. A plugin's `setInterval` keeps firing after
the plugin is disabled, so "stop posting" would not stop posting. The second is
a **composer** — media, per-network wording, per-network options — and the admin
bundle is built before any plugin exists, so a plugin can only describe panels
the SPA already knows how to draw. The `social` plugin remains, as the agency
planning layer above this one.

Nine networks: **X, Facebook, Instagram, Threads, LinkedIn, TikTok, YouTube,
Pinterest, Google Business**. A network belongs in `src/social/networks.ts` when
it can be *published* to, not when it can be authorized — a connect button
leading to a screen where nothing sends is the failure the plugin version of
this spent a release apologizing for, and `tests/social.test.ts` asserts the
catalog and the publisher register hold the same nine names. That file is also
everything that differs between them and is not code: caption limits, what media
is allowed, OAuth endpoints and scopes, and the handful of fields each one has
that no other does.

### Setting a network up

An OAuth client is registered *with the network*, against a redirect URI on your
domain, so there is nothing self-hosted software can ship instead. That is a fact
about where the value comes from, not about where it is typed — and requiring a
redeploy to turn a network on is the wrong answer for an operator with nine of
these to work through, approved one at a time over a fortnight.

So **Social → Settings** is a row per network: client id, sealed secret, an
enabled switch, endpoint overrides, and the redirect URI to copy. The secret goes
in `social_apps` under the same AES-GCM helper AI credentials use, emphatically
*not* in `settings` — `readScope()` reads that table wholesale and hands it to
plugin panels, which is the wrong shape for a secret. Only the last four
characters are ever returned.

`SOCIAL_OAUTH_<NETWORK>_*` still works and is read for any network with no row,
so an install configured before that screen existed keeps running and can move
one network at a time. `apps.ts#clientFor` is the only thing that knows there are
two sources; everything else asks it.

**Set up and switched on are different states.** An operator mid-way through a
network's review wants the credentials saved and the network not yet offered, so
`enabled` is its own column rather than being inferred from a client id.

Each row carries a **"?"** opening the walkthrough in `src/social/guides.ts`:
what a developer app is, the actual names of the actual buttons in that
network's console, how long it really takes including the waiting, and the one
step everybody gets wrong. The guides ship in the settings payload rather than in
the admin bundle, so a console that moves is a server-side correction rather than
a release.

### Four tables, four lifetimes

| | |
|---|---|
| `social_apps` | The developer app per network: client id, sealed secret, and whether it is switched on |
| `social_accounts` | An authorized account. Sealed tokens, AES-GCM under `SECRET`, the same helper AI credentials use. Not a content type, because every content type is readable through an editor screen, a revision, the search index, and the delivery API, and a refresh token belongs in none of those |
| `social_posts` | The copy. Written once and then *sent* |
| `social_targets` | One row per (post, account): the wording that network got, what it did with it, and where it landed |

The split between the last two is the design. A post to four networks has
sixteen interesting outcomes and only one is "it worked"; a single `status`
cannot hold that, so the post's status is a *roll-up* of its targets —
`partial` exists because it is the common real case and neither "posted" nor
"failed" is honest about it. `network` is denormalized onto the target so a
disconnected account cannot take the record of where a post went out with it.

### Sending

`publish.ts#send` runs every target independently and records each outcome
against its own row. Nothing about one network's failure reaches another's, and
a target already `posted` is skipped — so pressing "post now" again after
fixing the one network that refused retries only that one.

Failure is an exception thrown by the publisher, carrying **the network's own
words**. Every one of these fails for reasons only the network can explain
("the video is 63 minutes and the limit is 15"), that text is what an operator
acts on, and a summary of ours would be strictly worse.

`publishDue` runs every 60s beside the entry sweep. It picks up scheduled posts
whose time has come *and* anything left in `publishing` for over fifteen minutes
by a process that died mid-send — a post nobody will ever finish is worse than
one attempted twice, and every target already knows whether it went out.
`claim` is the lock: an UPDATE matching on the status it expects to replace, so
two sweeps racing means one changes no rows and stops.

### Per-network, and what it cost

Each publisher is one file under `src/social/publishers/`, and the differences
between them are not incidental:

- **X** — media is a separate service. An image goes up in one request; a video
  goes up in three plus a poll, because X transcodes and the tweet cannot
  reference the media until that finishes. `media.write` is in the default
  scopes for exactly this reason.
- **Facebook** — posts to a **Page**, not a profile: `oauth.ts` trades the
  person's token for the Page's at connect time, which is also what makes the
  connection long-lived.
- **Instagram** — the same Facebook app and the same Page, plus a Business
  account linked to it; a personal account has no posting API at all. Nothing
  posts in one call: every shape is *container then publish*, a carousel is
  that once per child and once for the album, and a video container has to
  finish transcoding before it can be published. A single video is a Reel
  because Instagram removed every other kind.
- **Threads** — the same container-then-publish shape on a different host, from
  a separately registered Threads app. Text-only skips the wait; there is
  nothing to transcode.
- **LinkedIn** — three steps per attachment: register an upload slot, PUT the
  bytes where it points, reference the returned *asset urn* in the post. The
  API is Rest.li, so a request missing `x-restli-protocol-version` is answered
  with a 426 rather than a hint.
- **TikTok** — `FILE_UPLOAD` rather than `PULL_FROM_URL`, because pulling needs
  a domain verified in TikTok's console, which an operator cannot do from
  inside Inkling. Every response carries an `error` object even on success
  (`code === "ok"`), and an unaudited app may only post privately — which is
  why the composer defaults that network's visibility to "Only me".
- **YouTube** — resumable upload, because a video is the whole payload and a
  connection that drops at 90% of a simple upload has nothing to resume from. A
  YouTube title is a separate mandatory field, not the caption.
- **Pinterest** — an image pin is one call; a video pin is four, and the bytes
  go to *Amazon* with policy fields Pinterest hands back, which is why that one
  request carries no bearer token. A video pin also needs a still cover
  Pinterest will not generate, and it is the only network where an image
  alongside a video means something — `coverImage` on the media rule exists for
  it alone.
- **Google Business** — split across four hosts, and the posting half never
  moved to v1. Discovery runs on the modern hosts and the post itself goes to
  `mybusiness.googleapis.com/v4`. A post attaches to one *location*, so the
  connection stores both halves of that path together.

**Five of the nine fetch media rather than being handed it** — Facebook,
Instagram, Threads, Pinterest, Google Business — which makes them the only
publishers that can fail because of where Inkling is running. A localhost
`PUBLIC_URL` is checked explicitly and says so, because each network's own error
is about a URL it could not download and reads as their fault.

Three spellings leaked into `src/oauth`: TikTok calls the client id
`client_key`, separates scopes with commas, and rejects the request when client
credentials also ride in an `Authorization` header (X requires it). All three
are named options on `OAuthClient` with spec-conforming defaults, so that module
still knows nothing about what is being authorized.

### Permissions, and validation timing

Social splits three ways rather than two, because sending is irreversible in a
way publishing an entry is not — an entry can be unpublished, a tweet has been
read. `writeSocial` (author) writes the post, `publishSocial` (editor) decides
it goes out, `manageSocial` (admin) connects the accounts. A save from an author
cannot move the send time; it keeps whatever an editor set.

Everything a network will refuse is checked **at save time**, not at publish
time. A scheduled post that turns out to be unpostable at 6am on Saturday is a
notification nobody reads, and every one of these — caption length, one video
per post, images or a video but not both — is knowable when it is typed. The
admin repeats the same rules client-side so the composer can say so while it is
being written; the server stays the authority.

## Auth and permissions

Roles are a strict ladder: `viewer < author < editor < admin < owner`.
Capabilities live in `src/auth/roles.ts` as predicates (`can.publishContent`),
and routes guard with `requireCan(can.x, "…")` so permission rules are in one
place rather than scattered role-string comparisons.

Each capability also carries a **scope name** — `content.publish`,
`settings.manage` — and those names are the vocabulary agent-key grants are
written in. That is the whole reason they exist: a machine credential has to be
narrower than the account behind it, and "narrower" is only checkable if the
route layer and the grant list are naming the same things. `requireCan` reads
`.scope` off the predicate it is handed, so route code did not change and cannot
forget.

There are three credentials, and keeping them apart is load-bearing:

| | who holds it | reaches | table |
|---|---|---|---|
| **session JWT** | a person, in a browser | all of `/api`, per role | `sessions` |
| **agent key** `inkagt_…` | a program | `/api`, per role ∩ grants | `agent_keys` |
| **delivery key** `ink_…` | a website | `/content`, `/site` | `api_keys` |

They are told apart by prefix in `requireAuth`, and a JWT can never begin with
`inkagt_`. A delivery key is refused on `/api` and an agent key is refused on
`/content`, in both directions — mixing them would mean a website key that leaks
into a repository becomes admin access.

Session JWTs carry a `jti` bound to a `sessions` row, so logout and "sign out
everywhere" work server-side. Every request re-reads the user, so a demoted or
deleted account loses access immediately rather than at token expiry. An
unrecognized role string falls back to `viewer` rather than being trusted.

Login is rate-limited on two buckets — per account and per IP — so neither a
single account nor a spraying host can be ground down. It does equal work
whether or not the account exists, so it can't be used to enumerate accounts.

Admins cannot create, edit, or promote above their own rank, and the last owner
cannot be deleted. Admin-forced password resets update the hash and revoke the
user's active sessions in one transaction.

API keys are stored only as SHA-256; the plaintext is shown exactly once. A
key's `scopes` is a validated list of content-type names, or `[]` meaning all,
and keys can have an explicit expiration time.

### Agent keys

`src/agents/` — how a program signs in. An MCP server, a build script, a
migration. The alternative it replaces is worth naming, because it is what
`scripts/mcp.ts` used to do: hold an owner's email and password and sign in.
That is not a scoped credential, it is the account. Anything that could read the
environment could mint delivery keys, register webhooks, connect a social
account, or create a second owner — whatever tool list sat in front of it — and
revoking it meant changing the password, which signs every person out too.

Four rules, and each one closes a way that failed:

1. **Never more than its account.** The effective permission is the grant list
   intersected with the account's *live* role, re-read per request. Demote the
   account and every key it minted narrows with it.
2. **Content only.** `GRANTABLE_SCOPES` excludes `users.manage`, `keys.manage`,
   `webhooks.manage`, `plugins.manage`, `ai.manage`, `ai.use`, and
   `social.manage`. Those are not "not granted by default" — they are not
   grantable, so no key exists that reaches them. Every one of them is either an
   escalation (create an owner, mint a longer-lived credential) or a way to
   reach outside this install (a webhook URL, a connected account).
3. **Revocable alone.** Cutting off an agent is one row, not a password change.
4. **Minting is human-only, and asks for the password again.** A key that could
   mint a key would be its own renewal; and without the password step, a stolen
   fourteen-day session token could be traded for a ninety-day one that survives
   "sign out everywhere".

Anyone may mint a key for themselves — it can never exceed them, and making an
admin do it for every editor is the friction that sends people back to sharing a
password. Admins with `keys.manage` see and revoke everyone's.

Three places had to change so the grants actually bite. Routes that read
`can.x(identity.role)` directly now call `allows(identity, can.x)`, because
reading the role alone is exactly how a key would inherit everything its account
can do. Read routes that were `requireAuth` alone now name `can.readContent`,
which every role passes — the point is that `content.read` becomes checkable.
And soft-deleting an entry keeps its author-plus-ownership role rule but adds
`requireGrant("content.delete")`, so a key allowed to draft cannot empty the
site.

`GET /api/agents/me` reports what a credential may actually do. `scripts/mcp.ts`
calls it at startup and publishes only the tools its grants cover — but that is
presentation, so the model does not plan around a call that would 403. The
refusal happens in Inkling. Audited content changes carry `agentKeyId` in their
metadata, so the trail distinguishes "Wess published this" from "a program
holding Wess's key published this".

## Admin SPA

`src/web/app.tsx` — a single-file React 19 SPA, hooks only, no router
dependency. It includes first-run setup, content-model and entry editors,
categories, nested menus, media, trash, scoped keys, webhooks, plugins, users,
settings, activity history, and global search. Rich-text fields use a focused
formatting surface that stores portable, cleaned HTML; entry history can be
inspected before restore. Content and media lists paginate rather than silently
stopping at a fixed first page.

`src/web/help.ts` is the prose behind every `?` in that SPA, keyed by id and
checked at build time, so a control pointing at help that does not exist is a
type error rather than an empty modal. It is a separate file because help text is
writing: it needs one voice, one place to review it, and somewhere to translate
it from, none of which survive being scattered through an eight-thousand-line
component file. The `?` opens a modal rather than a tooltip — a hover reveals
nothing on a touch screen, and the question behind the press is usually "what
happens to everything else if I change this", which does not fit in a caption.
The modal renders through a portal: a `?` sits wherever its field sits, and some
of those fields are inside a collapsed `<details>` that would otherwise hide the
dialog along with itself.

`src/web/serve.ts` bundles it with `Bun.build` and hands back a *handler*, not a
server. `src/server.ts` calls it once at boot and falls through to it for
anything the router doesn't claim, so there is no second process and no proxy —
the bearer token is same-origin by construction and CORS never enters the
picture. `bun --hot` re-runs the module on change, which rebuilds the bundle.

The admin sets its own Content-Security-Policy, in `serve.ts`, on the document
response — not through `withSecurityHeaders`, which stays `disableCsp: true`. A
policy only governs a document, and a blanket one would also land on media,
where `frame-ancestors 'none'` would stop a consuming site embedding a PDF it is
entitled to. It matters because the admin keeps a fourteen-day bearer token in
`localStorage`, which makes any script on this origin a session thief:
`script-src 'self'` plus a **sha256 hash** of the one inline line (`__INKLING_BASE__`)
is what keeps that from being one bad `innerHTML` away. Hash rather than
`'unsafe-inline'`, which would defeat the point. `connect-src` names the
WebSocket origin explicitly — `'self'` does cover same-origin `ws:` in current
browsers, but the rule is subtle enough to be worth spelling out.

Three inherited-from-experience details. `NODE_ENV` must not be `development` in
production or Bun bundles against the dev JSX runtime while resolving React to
the production build that lacks `jsxDEV`. The `crossorigin` attribute Bun.build
injects is stripped, because Safari otherwise fetches same-origin assets in CORS
mode, fails, and offers to download the bundle. And emitted chunk paths are
rewritten from `./chunk-…` to `/chunk-…`: the relative form resolves against the
current URL, which is fine at `/` and 404s on any deep link like
`/c/post/<id>` — a blank admin on every refresh.

## Storage

`src/storage/` is the only place blob backends are touched: a `StorageDriver`
interface (`put` / `get` / `drop`), a discriminated config, and a dispatcher.
Adding a backend is a new file plus a case.

The interface deliberately omits `signedUrl`. Every read goes through the API so
access rules stay enforceable in one place; adding presigning would create a
second, unguarded read path.

Keys are `<year>/<month>/<random>/<sanitized-name>` — dated so a bucket stays
browsable, randomized so two uploads of `logo.png` never collide.

Image dimensions are parsed from PNG/JPEG/GIF/WebP headers directly, which is
enough for the editor to lay out an image without a native image dependency.
