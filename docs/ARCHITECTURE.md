# Architecture

Inkling is a headless CMS: a content API plus an admin SPA, extended by
plugins. It stores content, and websites read it over an HTTP delivery API.
It does not render your site.

```
                    ┌──────────────────┐
                    │  admin SPA :4310 │   React 19, proxies /api/* → API
                    └────────┬─────────┘
                             │ bearer session
                    ┌────────▼─────────┐
   your website ───▶│    API :4300     │───▶ Postgres or SQLite
   (delivery key)   │  src/server.ts   │───▶ blob storage (local | S3)
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │  plugins/*       │  content types, routes, hooks
                    └──────────────────┘
```

## Two audiences, two surfaces

| | Admin API | Delivery API |
|---|---|---|
| Auth | session JWT (`Authorization: Bearer`) | API key (`X-Api-Key`) |
| Access | everything, role-gated | published content only, read-only |
| Routes | `/auth`, `/types`, `/entries`, `/media`, `/plugins`, … | `/content/*`, `/site/*` |
| Consumers | the admin SPA | your websites |

A delivery key can never see a draft, a user's email, or a soft-deleted row.
Referenced entries are re-checked for `published` status and the delivery key's
content-type scopes during expansion, so a reference cannot leak a draft or
content outside the key's allowlist. Delivery responses are private-cacheable
and vary on the credentials that shape them.

## Composition root

`src/server.ts`, in order:

1. Run migrations (`src/migrate`)
2. Bootstrap the first owner from `BOOTSTRAP_*` when supplied. Otherwise the
   one-time `/auth/setup` flow lets the first admin visit claim an empty site;
   it closes permanently as soon as an owner exists
3. Build the storage driver and the hook bus; bridge core hooks → webhooks
4. Load plugins in dependency order, auto-enabling `PLUGIN_AUTOENABLE` on a
   fresh install
5. Assemble routes from feature factories
6. Start background sweeps (`setInterval`): scheduled publishing every 60s,
   rate-limit cleanup hourly
7. `Bun.serve` wrapped in `withSecurityHeaders`

Each feature is `src/<feature>/index.ts` exporting a route factory. Signatures
vary by dependency: `authRoutes(db)`, `entryRoutes(db, hooks)`,
`mediaRoutes(db, store, hooks)`, `pluginRoutes(db, hooks, registry, dir)`.

## Dialect portability

One migration set runs on both Postgres and SQLite. That is only possible
because every column type round-trips to the same JS value on both drivers:

| Concept | Column | Why not the obvious choice |
|---|---|---|
| Primary key | `TEXT` uuid | `SERIAL` vs `INTEGER PRIMARY KEY AUTOINCREMENT` aren't portable. UUIDs also let content move between environments without renumbering foreign keys. |
| Timestamp | `TEXT` ISO-8601 | Postgres `TIMESTAMPTZ` returns a `Date`; SQLite returns a string. ISO text also makes lexical sort equal chronological sort. |
| Boolean | `INTEGER` 0/1 | Postgres `BOOLEAN` returns `true/false`; SQLite returns `0/1`. |
| JSON | `TEXT` | Postgres `JSONB` arrives pre-parsed; SQLite doesn't. |
| Column names | snake_case | `@atlas/db` emits identifiers **unquoted**. Postgres folds camelCase to lowercase, SQLite preserves it — so a camelCase column returns a differently-spelled key per driver. |

The two places dialects genuinely differ are isolated in `src/db/dialect.ts`:
`contains()` picks `ILIKE` vs `LOWER(...) LIKE`, and `countRows()` normalizes
Postgres's BIGINT `COUNT` (which may arrive as a string).

SQLite connections enable foreign-key enforcement when opened. Each migration
runs in a transaction, including its `schema_migrations` record, so a partial
file is rolled back rather than being recorded as applied.

`tests/postgres.test.ts` exercises this against a real Postgres when one is
reachable, and skips otherwise so the default `bun test` needs no setup.

### The migration runner

`src/migrate/index.ts` replaces `@atlas/migrate#up`, which hands a whole
`up.sql` to `db.execute` as a single statement — and bun:sqlite's
`prepare(sql).run()` executes only the *first* statement of a multi-statement
string while reporting success. Ours splits on statement-terminating semicolons
(respecting quoted strings, `--` and `/* */` comments, and `$$` dollar-quoting)
and executes each file transactionally. It also namespaces plugin migrations in
`schema_migrations` as `plugin:<name>/<migration>`.

## Data model

16 core tables. The spine is `content_types` → `entries` → `revisions`, with
`media`, `taxonomies`/`terms`/`entry_terms`, `menus`, `settings`, `api_keys`,
`webhooks`, `plugins`, `users`/`sessions`, and `audit_events`/`rate_limits`.

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
`stats` panel).

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
stopping at a fixed first page. `src/web/serve.ts` bundles it with `Bun.build`,
serves `index.html` for any extension-less path, and proxies `/api/*` to the
API so the bearer token stays on one origin and CORS never enters the picture.

Two inherited-from-experience details: `NODE_ENV` must not be `development` in
production or Bun bundles against the dev JSX runtime while resolving React to
the production build that lacks `jsxDEV`; and the `crossorigin` attribute
Bun.build injects is stripped, because Safari otherwise fetches same-origin
assets in CORS mode, fails, and offers to download the bundle.

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
