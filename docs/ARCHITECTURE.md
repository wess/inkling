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

Pass `server` through to `fetch`. `withSecurityHeaders` is applied inside
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

17 core tables. The spine is `content_types` → `entries` → `revisions`, with
`media`, `taxonomies`/`terms`/`entry_terms`, `menus`, `settings`, `api_keys`,
`webhooks`, `plugins`, `users`/`sessions`, `ai_credentials`, and
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

**The agent** (`POST /ai/agent`, `src/ai/agent.ts`) is the assistant given the run
of the content model rather than one field: it lists content types, reads entries
and media, works out which page you meant, and comes back with changes. It is a
tool loop over `src/ai/tools.ts`, streamed over SSE so the tool trace is visible
as it happens, and it holds no server-side state — the transcript rides back and
forth with the browser, which is refused rather than truncated when it outgrows
its cap.

**Every tool in that surface is a read.** The agent cannot write, and no flag
makes it able to: `propose_entry_update`, `propose_entry_create`, and
`propose_type_update` record an intention and hand it to the admin, which renders
a diff and applies it by sending the change through `PUT /api/entries/:id` — the
same route a human edit takes. That keeps one write path in the codebase, so
revisions, field validation, slug uniqueness, relation checks, hooks, and the
audit trail all keep working without a second implementation to keep honest, and
the history names the person who approved the change rather than a machine nobody
can ask about it. `tests/aiagent.test.ts` asserts the tool list contains nothing
but reads and proposals, because a write tool added later would otherwise fail
silently — the first sign would be a published page changing by itself.

The agent needs a provider that supports tool use, which today means Claude;
connected to anything else it says so and the editorial assistant carries on
working. Content the agent reads is fenced and declared to be material, the same
way the assistant fences it.

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
rebuild. Four kinds: `settings`, `collection`, `table` (an endpoint plus
columns), and `stats`.

A `stats` panel is a plugin's dashboard. Its endpoint returns a `PluginStats`
payload — tiles, one series, and any number of top-N tables — and the SPA lays
out what it is handed. The plugin does all the aggregating *and* the formatting,
including thousands separators and rounding, so a panel never has to guess what
a number means. `ranges` adds a day-window switch that re-requests with `?days=`.

Bundled: `seo` (delivery filter), `redirects` (plugin-owned type + public
route), `forms` (own table via plugin migrations), `commerce` (types +
taxonomy + settings + route), `analytics` (own table + public write route +
`stats` panel), `assistant` (public AI answers grounded in published content),
`social` (four types, an `entry.beforeSave` filter, and two `stats` panels).

### Social

`social` is social media management on top of the pieces that already exist.
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

Nothing is posted to any network. That would mean an OAuth app per network, a
token per client, and a refresh loop that fails at 3am; a plugin that quietly
stopped posting would be worse than no plugin.

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

## Auth and permissions

Roles are a strict ladder: `viewer < author < editor < admin < owner`.
Capabilities live in `src/auth/roles.ts` as predicates (`can.publishContent`),
and routes guard with `requireCan(can.x, "…")` so permission rules are in one
place rather than scattered role-string comparisons.

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

## Admin SPA

`src/web/app.tsx` — a single-file React 19 SPA, hooks only, no router
dependency. It includes first-run setup, content-model and entry editors,
categories, nested menus, media, trash, scoped keys, webhooks, plugins, users,
settings, activity history, and global search. Rich-text fields use a focused
formatting surface that stores portable, cleaned HTML; entry history can be
inspected before restore. Content and media lists paginate rather than silently
stopping at a fixed first page.

`src/web/serve.ts` bundles it with `Bun.build` and hands back a *handler*, not a
server. `src/server.ts` calls it once at boot and falls through to it for
anything the router doesn't claim, so there is no second process and no proxy —
the bearer token is same-origin by construction and CORS never enters the
picture. `bun --hot` re-runs the module on change, which rebuilds the bundle.

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
