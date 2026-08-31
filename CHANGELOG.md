# Changelog

Inkling is consumed as a git dependency and pinned by tag, so this file exists
for one reader: someone deciding whether to move a site from one tag to the
next. Entries say what changed and what it means for an install, not what was
refactored.

Dates are release dates. From 1.0 this is semver: a major for a breaking change
to the delivery API, `createInkling()`, the plugin interface, or the shape of a
content type; a minor for new surface; a patch for fixes alone.

## Unreleased

### Added

- **Social plans now connect to delivery.** A planned social post can reference
  the core publisher record, and its status and errors stay synchronized there.
  Delivery retries transient target failures with persisted backoff state while
  permanent failures wait for an operator.

## 1.9.0 — 2026-08-27

### Added

- **A `google` plugin, enabled by default.** One plugin for Google Analytics and
  Google Ads, split in half because Google sells it as one thing and it is two.

  Pasting a **Measurement ID** under **Google → Setup** puts Analytics on the
  site. Five minutes, no Google Cloud project, no consent screen, nothing for
  Google to approve. Inkling generates the snippet — preferring a Tag Manager
  container when one is set, because a container almost always has Analytics
  inside it and sending both is what makes every number read double — and
  `GET /ext/google/tag` serves it to a front end holding a delivery key, so a
  site can fetch its tag instead of hard-coding it. An Ads conversion ID rides
  along in the same snippet.

  Reading those numbers back into Inkling's own panels is a second, optional
  part: connect a Google account and the **Traffic** panel fills in with people,
  visits, most-read pages and how they arrived. **Ads** shows spend, clicks, cost
  per click and per conversion, and the campaigns behind them. Neither panel is
  needed to measure anything, and nothing in the first part mentions them.

- **A `guide` panel kind: a setup walkthrough that knows how far along it is.**
  Its endpoint returns numbered steps in `parts` — a cheap half and an expensive
  half, because presenting them as one eleven-step list makes the cheap half look
  like it needs the expensive one. A step ticks itself off, offers a value to
  copy, collects the value it is asking for right there rather than sending
  somebody to another screen, lists what only the connected account could know
  (which Analytics property, which Ads account, so nobody hunts for a numeric id
  in a console), and can start an OAuth flow. Every word belongs to the plugin.

  `google`'s guide names the trap at each step rather than the happy path: the
  redirect URI that has to match to the character, the test-user list without
  which Google refuses an unverified app, the `UA-` id that has collected
  nothing since 2023, the Ads developer token that returns zeros rather than an
  error while it is on test access.

- **A `secret` plugin setting type.** Declared like any other setting, sealed
  with the same AES-GCM as every other stored credential. The plugin reads
  plaintext from `getSetting` and does not know it was ever encrypted; the API
  and the assistant's `list_plugins` both get four characters. Saving a form
  that never showed the secret leaves it alone, and clearing one takes an
  explicit Remove. This is what lets a Google client secret and an Ads developer
  token be typed into the admin instead of edited into `.env` over SSH.

- **A `stats` panel can carry a `note`.** A dashboard with nothing in it can now
  say which step is missing instead of reading as broken — the Traffic panel
  distinguishes "your site is not being measured yet" from "it is, and these
  numbers are in Google's reports until you connect an account".

- **A `connections` row can carry its own `hint`.** Previously an unconfigured
  row always named the `SOCIAL_OAUTH_*` variables, which is right for a social
  network and wrong for anything else.

### Documentation

- **A truncated paragraph in `docs/ARCHITECTURE.md` is repaired.** An earlier
  edit left a half-finished "Bundled:" list running mid-sentence into the
  paragraph after it.

## 1.8.2 — 2026-08-27

### Fixed

- **Webhook delivery re-checks DNS at send time.** A hostname that was public
  when saved can later resolve to a loopback, private, link-local, or metadata
  address; dispatch now refuses that request as well as guarding redirects.

## 1.8.1 — 2026-08-27

### Fixed

- **Admin builds no longer accumulate on disk.** The runtime bundle and its
  hashed assets stay in memory for the life of the handler, and those assets now
  carry an immutable one-year cache policy. A development checkout that had
  been running since July had collected 261 MB of obsolete chunks. A failed
  admin build also happens before background intervals start, so an embedding
  host can catch and retry a failed boot without leaving sweeps behind.
- **`GET /content` now carries the same private cache boundary as every other
  delivery response.** Its list of content types depends on the delivery key's
  scopes; without `private` and `Vary: x-api-key`, a shared cache could hand one
  site's discovery response to another key. Delivery list counting, expansion,
  terms, and bylines now run independent database work concurrently as well.
- **A plugin settings save is atomic.** Multiple values are written in one
  transaction, so a failure cannot leave half of a settings form applied.
- **The MCP server speaks both current and established protocol revisions.**
  Current clients can negotiate `2026-07-28` through `server/discover` and
  per-request metadata; existing `2025-11-25` and `2025-06-18` initialization
  clients keep working. Unknown versions get a deterministic supported-version
  response, independent calls no longer block each other, and cancellation
  cannot produce a late tool result.

### Documentation

- **The GitHub Pages site is canonical at `wess.io/inkling`.** README links,
  package metadata, canonical tags, the release runbook, sitemap, and the
  Pages-only School link now agree with the repository's actual Pages setting.
  The site also has a designed 404 page, a keyboard skip link, and a mobile nav
  that stays usable without swallowing the first viewport.
- **Documentation is validated before it publishes.** `bun run docs` checks page
  metadata, duplicate ids, local files, anchors, and the machine-readable docs;
  both CI workflows run it. The setup guide no longer suggests putting a
  literal shell expression in `.env`, and the embedding tutorial now carries
  the required request ceiling and idle timeout through `serveOptions`.
- **Agent-facing documentation follows the `llms.txt` convention.** The small
  routing file links to focused Markdown guides for MCP site operations and the
  delivery API, with the longer product and codebase context available as
  `llms-full.txt`. Every HTML page advertises the machine-readable entry point,
  and the tutorials now include a safe external-agent setup.

## 1.8.0 — 2026-08-21

Inky could change your pages, their shapes, your menus, and your site details.
It can now change everything else too — and, for the four things that genuinely
need a person, it puts you on the screen instead of describing the route.

### Added

- **Inky reaches the whole admin.** On top of pages and their shapes it now
  reads and proposes changes to **categories and tags**, **alt text and captions**
  on uploaded files, **new menus** and deleting them, **plugins** (on, off, and
  their settings), **people's roles**, **delivery keys**, **webhooks**, and the
  **social setup**. Thirty-eight tools where there were thirteen. Every one is
  still a read or a proposal: nothing is saved until you press Apply, and
  applying still goes through the same route your own edit takes.
- **It walks you through connecting a social network.** Posting needs three
  things in order — a developer app registered with the network, its client ID
  and secret saved here, and an account connected — and the usual reason nothing
  works is that one of them is missing. Inky reads which, says so plainly, and
  then talks you through that network's console a step at a time, using the same
  register the Social settings screen shows: the real button names, the honest
  timings, and the one step everybody gets wrong. It will ask you for a client
  ID. It will **not** ask you to type a client secret to it — that is a password,
  so it takes you to the field instead, and masks one in the diff if you have
  already pasted it.
- **Inky can move the admin.** When the next step is somewhere else — after
  queueing something you will want to look at, or when the last step needs your
  hands — it takes you there rather than naming a screen. The four that need your
  hands are uploading a file, creating an account, pressing Connect on a network,
  and pasting a secret. Leaving an unsaved editor still asks first.
- **Applying a proposal that mints a secret shows it once**, in the same "copy
  this now" dialog the Keys screen uses. That covers a new delivery key and a new
  webhook's signing secret.

### Changed

- **Inky is only offered what your role could actually apply.** Every tool names
  the permission its proposal will need; the list is filtered before Inky sees
  it, and each proposal carries that permission so a single card is greyed rather
  than the whole tray. Previously an author was shown the site-settings and
  content-type tools, would confidently queue a change, and meet a refusal on the
  button — which read as a bug rather than a rule. Nothing has been widened: what
  an account could do by hand is exactly what it can do here.
- `POST /api/ai/agent/status` returns `scopes` — the capabilities the account
  holds — in place of the single `mayApply` flag. Admin-internal; nothing outside
  the bundled admin reads it.
- `src/ai/tools.ts` became `src/ai/tools/`, grouped by area, with each tool's
  schema and handler in one object. **Embedders calling `agentRoutes` directly
  now pass the plugin registry as a second argument** — `createInkling` does this
  for you, so a standalone or embedded install needs no change.

## 1.7.0 — 2026-08-17

### Added

- **The admin explains itself.** Every control that is not self-evident now
  carries a `?`, and pressing it opens a plain explanation: what the thing is,
  one concrete example, and — the part nobody writes down — what it affects
  elsewhere or what cannot be undone. Written for the person who did not build
  the site, which is most of the people using one. Coverage went from 25 fields
  to 50, across the editor, media, the content-type and field builders, site
  settings, people and roles, keys, webhooks, menus, categories, and AI.
- It is a **modal rather than a hover tooltip**, which is the point: a hover
  reveals nothing at all on a phone, and a tooltip has room for a caption rather
  than an explanation.
- Help a site builder writes into a field's own **Help text** is unchanged — it
  still appears in full under the control rather than behind a mark, because
  guidance written for your own colleagues should not have to be gone looking
  for.

### Fixed

- A `?` inside the collapsed **Advanced** section of the field builder opened a
  dialog that was hidden along with the section, so pressing it appeared to do
  nothing. Help now renders through a portal, which also covers any ancestor
  with overflow or a transform.

## 1.6.0 — 2026-08-17

The public assistant — the chat bubble a site's own visitors talk to — gets the
review it should have had before it was pointed at the open internet, plus the
two things a specialist needs: a description of what it is for, and content it
is actually scoped to.

### Changed

- **An assistant nobody has scoped now answers from nothing.** `Content it may
  answer from` treated an empty list as "every type the delivery key may read",
  which made the configuration nobody had touched the widest one. Empty is now a
  refusal. **If you have the bubble switched on, name your types before
  upgrading** or it will politely decline everything.
- **The site owner's guardrails no longer outrank the software's.** They used to
  be added last, "so they win any conflict" — right for tone, wrong for claims:
  a persona reading "tell customers what our oils cure" won. Built-in rules are
  now last and say so.
- **Retrieval matches words, in titles and bodies.** It matched the whole
  question against the title alone, so "do your gummies contain THC?" only found
  a page literally titled that — a customer's question grounded in nothing and
  the assistant refused on a site with the answer written on it.

### Added

- **Follow-up questions.** The conversation is held server-side for two hours
  and the browser carries only an opaque id, because a client that hands back
  its own transcript can forge what the assistant already said and steer the
  next answer with it. Nothing a visitor typed outlives the session — what an
  operator gets instead is a count of questions and how many found no content,
  which carries no personal data and is the part worth acting on anyway.
- **Rules the settings cannot switch off**: no claim that anything treats,
  prevents, cures, or relieves a condition; no dose; no statement about what is
  legal; no medical, legal, financial, or veterinary advice; no promise of a
  price, stock, delivery, or refund.
- **A site-wide ceiling of 500 answers a day**, above the per-visitor limit and
  deliberately not configurable. A thousand addresses each staying under thirty
  questions an hour is still thirty thousand answers on the operator's bill.

### Fixed

- **A scheduled entry could be answered from before it was published.** The
  bubble filtered on status and soft-delete but not on the publish date, so an
  entry dated next week — an embargo, a launch nobody has announced — was fair
  game. It now uses the same four predicates the delivery API does.
- **A provider failure reached the visitor verbatim**, naming the provider, the
  endpoint, and sometimes the state of the account paying for it. It reads as
  the configured refusal line, and the detail stops at the server.
- **A visitor's question is fenced** with a marker they never see and cannot
  guess, rather than appended after a literal `QUESTION:` label next to
  `<source>` tags they could imitate.

## 1.5.3 — 2026-08-17

### Fixed

- **The rest of the Claude fix.** 1.5.2 stopped sending `fallbacks` to models
  that reject it, and stopped asking for the beta that goes with it — but an
  empty beta list is not the same as none by the time it reaches the wire. The
  SDK still sent `anthropic-beta:` with nothing in it, and the API rejects a
  header it cannot parse: `Unexpected value(s) '' for the 'anthropic-beta'
  header`. So a Sonnet request that correctly declined to ask for the beta
  failed anyway, on the header announcing it. Both the betas and the fallback
  chain are now omitted rather than sent empty. Claude connections were still
  failing their test on 1.5.2; upgrade past it.

## 1.5.2 — 2026-08-17

### Fixed

- **Claude connections work again.** Every Claude request carried the
  `fallbacks` parameter, which the API accepts only from the models that can
  refuse in the first place — Fable 5 and Opus 5, the ones with safety
  classifiers. Anything else answers with
  `400 'claude-sonnet-5' does not support the 'fallbacks' parameter`, and Sonnet
  5 is the default model, so the default connection was the one that could not
  work: the connection test, the editorial rewrites and Inky all failed the same
  way. The parameter and its beta header are now sent only to the models that
  take them; a model that does refuse still gets its fallback.
- **A connection test no longer fails a reasoning model for thinking.** The test
  asks for one word and used to allow sixteen tokens for it, which is right for
  a model that answers immediately and wrong for one that reasons first: the
  budget is spent before the answer starts, and the reply comes back a
  well-formed 200 with no text in it. The admin then reported that the provider
  "returned no text" and pointed at the model name, which was fine. Seen on
  Ollama Cloud's hosted reasoning models.
- **A dangerous field pattern is now refused wherever it runs, not only in the
  editor.** 1.5.1 checked the pattern when a content type was *saved*, which is
  one of the ways a pattern gets stored — a plugin declares content types
  straight into the table, and rows written before 1.5.1 were never checked at
  all. Either way the regex still reached entry data on every save. The refusal
  now happens where the pattern is compiled, so all three paths are covered with
  no migration to run. A field whose pattern is refused fails validation with a
  message saying so instead of hanging, and a stored pattern that no longer
  compiles is a field error rather than a 500.

### Changed

- **`createInkling()` returns `serveOptions` for an embedding host to spread into
  `Bun.serve`.** It carries `maxRequestBodySize` — which 1.5.1 asked hosts to
  compute themselves from `config.maxUploadBytes` — and `idleTimeout`, which the
  examples had never mentioned. Both are values Inkling should decide rather than
  ask a host to remember, for the same reason `withSecurityHeaders` is applied
  inside `createInkling()`. Existing embedders need no change: setting the option
  by hand still works, and spreading `serveOptions` after it wins.

## 1.5.1 — 2026-08-17

Two more from the same audit pass, both denial of service by an authenticated
caller rather than a way in.

### Fixed

- **A request body had no ceiling.** Bun buffers a whole body before any handler
  runs and defaults to 128MB; `parseJson` called `request.json()` on whatever
  turned up, and the upload limit was checked only *after* multipart had already
  been parsed into memory. So any signed-in account could hold 128MB per request,
  and a few at once is an OOM on a box the size these run on. Capped at the
  configured upload limit plus framing headroom, refused at the socket where it
  costs nothing. An embedding host owns its own `Bun.serve`, so the README and
  the architecture doc now show the option in the example rather than leaving it
  to be discovered.
- **A field's `pattern` could hang the process.** It is a regex typed into the
  content-type editor and run against entry data on every save, and it was only
  ever checked for *compiling* — so `(a+)+$` was accepted, and one save then
  blocked the only JS thread there is. Measured on Bun 1.3: 24 characters of
  input costs about 135ms, and it climbs with both the input and the nesting
  (`^(([a-z])+.)+[A-Z]([a-z])+$` reaches seconds). Per field, per save, so a bulk
  publish multiplies it. Patterns that repeat an already-repeating group are now
  refused when the content type is saved, along with anything over 200
  characters, and compiled patterns are cached rather than rebuilt per entry.

  It does not take a malicious admin. Inky proposes content types, and a
  proposal is approved by someone reading the summary rather than the regex.

  The check is a heuristic and says so in the code — it catches the family of
  patterns that actually gets written, not every pathological one. The
  alternative was a dependency on RE2 for a feature most sites never use.

## 1.5.0 — 2026-08-17

The MCP server no longer holds your password, because it never should have.

1.4.0 shipped `scripts/mcp.ts` configured with `INKLING_EMAIL` and
`INKLING_PASSWORD`. It signed in and got an ordinary session — which meant the
credential in that environment file was not "the twenty-two tools listed in the
README", it was **the account**. Anything that could read it could mint delivery
keys, register webhooks, connect a social account, change the AI provider, or
create a second owner, whatever the tool list in front of it happened to say.
`INKLING_MCP_READONLY` filtered that list in the same process that held the
secret, so it was a convenience, not a boundary. And cutting an agent off meant
changing the password, which signs every person out.

That is replaced by a real credential with a real boundary, and the rest of this
release is the security work that went in alongside it.

**Read this if you run `bun run mcp`.** `INKLING_EMAIL` and `INKLING_PASSWORD`
are gone and the script refuses to start with them. Mint an agent key under
**Agent keys** in the admin and set `INKLING_KEY` instead. Nothing else changes:
the delivery API, `createInkling()`, the plugin interface, and the shape of a
content type are all untouched, and an install that does not run the MCP server
needs no action beyond deploying.

### Added

- **Agent keys** (`src/agents`, `/api/agents`) — how a program signs in. An MCP
  server, a build script, an automation. A key acts as the account that minted
  it, but only for the capabilities granted to it, and the effective permission
  is that grant list intersected with the account's *live* role on every
  request. Demote the account and every key it minted narrows with it.
- **The administrative surface is not grantable at all.** Managing users, delivery
  keys, webhooks, plugins, AI providers, and social connections are excluded from
  the grantable set, so there is no key that reaches them — not "off by default",
  *absent*. Every one of them is either an escalation (create an owner, mint a
  longer-lived credential) or a way to reach outside the install (a webhook URL,
  a connected account). Using the assistant is out too: a machine looping through
  it is the operator's bill.
- **Expiry required** — 90 days by default, 365 at most — and revocation is one
  row rather than a password change. `last_used_at` and `last_ip` are recorded,
  so a key used from somewhere new is visible without reading the audit table.
- **Minting is human-only and re-asks for the password.** A key that could mint a
  key would be its own renewal; and without the password step a stolen session
  token could be traded for a credential that outlives it and does not appear in
  "sign out everywhere". Anyone may mint one for themselves — it can never exceed
  them, and making an admin do it for every editor is the friction that sends
  people back to sharing a password.
- **The three credentials cannot be swapped.** A delivery key is refused on
  `/api` and an agent key is refused on `/content`, so a website key that ends up
  in a repository is still only a website key.
- **`GET /api/agents/me`** reports what the calling credential may actually do.
  The MCP server reads it at startup and publishes only the tools its grants
  cover, so the model does not plan around a call that would 403 — but that is
  presentation. The refusal happens at the route.
- **Audited content changes record which key acted.** "Wess published this" and
  "a program holding Wess's key published this" are different facts, and the
  morning something unexpected goes live is when you want them apart.

### Fixed

- **The admin now sends a Content-Security-Policy.** It keeps a fourteen-day
  bearer token in `localStorage`, which made any script on that origin a session
  thief, and the policy had been left off because the bundle's one inline line
  would have needed `'unsafe-inline'` to allow. It is pinned by sha256 hash
  instead. Set on the admin document rather than globally, so media stays
  embeddable on a consuming site.
- **Webhooks can no longer be pointed at your own network.** They were the one
  place an operator hands Inkling a URL and tells it to make a request, and the
  receiver's status came back in the response — a port scanner with a signature
  attached, reaching the database port, sibling containers, and the cloud
  metadata service that hands out credentials. Private, loopback, and link-local
  targets are refused when saved and again when fired, hostnames are resolved
  rather than only pattern-matched, and redirects are no longer followed. Set
  `WEBHOOK_ALLOW_PRIVATE=true` if your receiver really is internal.
- **An upload's `Content-Type` is checked against its bytes.** It is a claim, and
  it decided whether a file was served inline on the same origin as the admin.
  A file whose header says PNG and whose body is a document is now stored as a
  download.
- **A malformed preview token answers 401 rather than 500.** Both halves are
  base64url and `atob` raises outside that alphabet, so `/preview/@@@.@@@` was an
  unhandled error where the honest answer is "this link is invalid".
- **Capabilities that a route checked by reading the role directly** — publishing,
  editing someone else's entry, sharing a preview — now go through `allows()`, so
  an agent key cannot inherit them past its grants. Read routes name
  `content.read`, which every role already passes; the point is that the scope
  becomes checkable.

## 1.4.0 — 2026-08-13

An agent can now work a site from outside it. `scripts/mcp.ts` serves Inkling's
admin API as MCP tools over stdio, so a coding agent in a terminal can read and
edit content the same way a person at the admin does.

This is the gap Inky does not cover, and deliberately so. Inky sits *inside* the
admin and every change it makes is a proposal a human applies — right for an
editor already looking at the screen, useless to an agent editing a site from
somewhere else entirely. The two are the same constraint solved for different
rooms: Inky asks a person to press the button, this asks a person for the
credential.

**Nothing changes for an install that does not run it.** This adds no route, no
runtime surface, and no dependency — the delivery API, `createInkling()`, the
plugin interface, and the shape of a content type are all untouched. It is a
script you point at a site you already have credentials for.

### Added

- **`bun run mcp`** — 22 tools over entries, content types, media, menus,
  settings, taxonomy, search, and revisions. Configured by environment
  (`INKLING_URL`, `INKLING_EMAIL`, `INKLING_PASSWORD`) and run one process per
  site, because credentials are per-site and a `site` argument on every tool
  would mean holding all of them at once.
- **Every write goes through the same `/api` route the admin calls**, rather
  than a second path into the database. Revisions, validation, slug uniqueness,
  relation checks, plugin hooks, and the audit trail all keep working without a
  parallel implementation to keep honest, and history shows the account that
  made the change rather than a machine nobody can ask about it.
- **`INKLING_MCP_READONLY=1`**, for pointing an agent at production to look
  rather than touch. Write tools are hidden from `tools/list` as well as
  refused, so the model never plans around a call that cannot succeed.
- **stdio JSON-RPC, hand-rolled.** The framing is newline-delimited JSON and
  three methods — less code than the SDK's dependency tree would have been.
  Inkling still has four dependencies.

## 1.3.1 — 2026-08-13

### Fixed

- **The composer's network picker is now actually a set of checkboxes.** It was
  a row of buttons whose on/off state was carried entirely by a colour and a
  tick, with nothing programmatic behind it — a screen reader announced nine
  plain buttons with no indication which were selected, and keyboard focus drew
  no ring at all. They are real `<input type="checkbox">` in a real `<fieldset>`
  now, drawn as the same chips, with a box that ticks and a visible focus ring.
  Choosing where a post goes was the one control in that screen you could not
  operate without a mouse.

## 1.3.0 — 2026-08-12

Inkling posts to social networks. There is a **Social** section in the admin
with a composer, a calendar, an accounts screen, and a settings screen, and
posts actually go out — to **X, Facebook, Instagram, Threads, LinkedIn, TikTok,
YouTube, Pinterest, and Google Business**.

This is the half the `social` plugin never had. That plugin could authorize an
account and then do nothing with it, which the docs called deliberate and which
was really an admission: a plugin cannot own a background sweep, because its
`setInterval` keeps firing after the plugin is disabled, and it cannot ship a
composer, because the admin bundle is built before any plugin exists. Both of
those are core's to own, so this is core.

The other half of this release is the **S3 driver**, which has shipped since the
first commit and was never exercised — `STORAGE_DRIVER=s3` type-checked, booted,
and then failed in two ways that only a real bucket shows you.

### Added

- **Social → Overview, Posts, Calendar, Accounts.** Write a post once, give any
  network its own wording if it needs it, attach media from the same library
  everything else uses, and send it now or at a time. The month view draws what
  is scheduled; the overview says what is going out next, what went out last,
  and which connection needs attention.
- **Nine publishers, one per network**, each with the upload dance that network
  insists on: X's three-step chunked video upload and transcode poll, Facebook's
  unpublished-photos-then-feed-post, Instagram's container-then-publish (twice
  over for a carousel), Threads' same shape on a different host, LinkedIn's
  register-slot-then-PUT-then-reference-the-urn, TikTok's `FILE_UPLOAD`
  init/upload/status cycle, YouTube's resumable session, Pinterest's push to S3
  with their policy fields, and Google Business's legacy v4 local post. Adding a
  tenth is one file plus a catalog entry, and a test asserts the two lists
  match — a network that can be connected but not posted to is the failure this
  is built to prevent.
- **Social → Settings**, where networks are set up. A row per network with a
  client id, a secret sealed under `SECRET`, an on/off switch, endpoint
  overrides, and the redirect URI to copy. Set up and switched on are separate
  states, because an operator mid-way through a network's review wants the
  credentials saved and the network not yet offered.
- **A "?" on every settings row** opening a plain walkthrough of that network's
  console: what a developer app even is, the actual names of the actual buttons,
  how long it really takes including the waiting, and the one step everybody
  gets wrong — which is never the step the docs emphasise. The guides ship in
  the settings payload rather than in the admin bundle, so a console that moves
  is a server-side correction rather than a release.
- **A post's outcome is per network.** Sending records what each one did on its
  own row, with that network's own error text next to it. A post where X took it
  and TikTok did not reads as `part posted` rather than as a success or a
  failure, and pressing send again retries only what failed — what already went
  out is never posted twice.
- **Scheduled posts go out on a 60s sweep**, beside the one that publishes
  entries. A post left mid-send by a process that died is picked back up after
  fifteen minutes.
- **Three permissions rather than two.** An author writes a post; an editor
  decides when it goes out; an admin sets networks up and connects the accounts.
  Sending is
  irreversible in a way publishing an entry is not, and the roles say so — a
  save from an author cannot move the send time.
- **Everything a network will refuse is checked when the post is saved**, not
  when it is sent. Caption length, one video per post, images or a video but
  never both — except Pinterest, where a video *needs* a still cover it will not
  generate — and the networks that refuse a text-only post at all. The composer
  counts characters per selected network as you type.
- **`social.posted`** is a new `emit` hook, carrying the per-network outcome.
  There is no `before` half and there will not be: by the time anything could
  listen, the post is on someone else's servers.
- **`S3_PREFIX`** confines an install to one folder inside a bucket, so several
  sites can share one and you can still tell whose media is whose. The prefix is
  bucket layout, not content — it never enters `storage_key` or a media URL — so
  adding, changing, or removing it later is an environment change and a blob
  copy, never a data migration.
- **`S3_PUBLIC_URL` now also decides the ACL.** Objects are written
  `public-read` when it is set, because a public base in front of private
  objects is a CDN that 403s on every image. The two were separate settings that
  had to agree, which is a thing to get wrong rather than a choice to make.

### Fixed

- **Typing in a modal no longer throws the caret out of the field.** Every
  dialog in the admin — add a user, reset a password, and the rest — rebuilt its
  focus trap on each render, because the trap depended on an `onClose` prop that
  every caller passes as an inline arrow and therefore hands over new on every
  render. Each keystroke tore the trap down and reinstalled it, and installing it
  focuses the first control, which is the close button. A name with a space in it
  closed the dialog: the first character moved focus to that button and the space
  pressed it. Anyone adding a user hit this on the first field they typed into.
- **An upload no longer stores a URL the browser cannot fetch.** `put` returned
  the raw bucket URL, and buckets are private when created on every provider
  worth naming, so a site rendered a page of images that all 403'd. Uploads now
  return the same root-relative `/media/file/…` path the local driver does, and
  reads go back through the media route — the guarded path the storage module
  documents. An absolute URL is used only when `S3_PUBLIC_URL` says a CDN is
  serving the bucket.
- **A missing object is a 404 again, not a 500.** `get` was written to return
  `null` for an absent key, which is what the media route turns into a 404, but
  the underlying call throws on any non-2xx and the `null` branch was
  unreachable. A credential or network failure still throws: the one thing this
  must not do is report a broken bucket as an empty one.

### Changed

- **The `social` plugin's Accounts panel is gone**, and so are its OAuth routes.
  Accounts live in the Social section now. The plugin keeps what it was always
  best at — clients, campaigns, the client-facing queue, the calendar, and the
  performance report — and its `socialpost` type stays what it is: a commitment
  made to a client, which is a different thing from a post that gets sent.

### Upgrading

Existing connections are kept. `social_accounts` is now created by a core
migration with the shape the plugin's migration used, so an install that had
connected accounts keeps its rows and its sealed tokens.

Two things need doing:

1. **Register the new redirect URI** with each network. It moved from
   `PUBLIC_URL/ext/social/oauth/callback` to `PUBLIC_URL/social/oauth/callback`.
   It is printed on Social → Settings, on each network's row, for copying.
2. **Reconnect Facebook**, if it was connected before. Facebook posts to a Page
   and the Page's own token is what is now stored; a connection made under the
   plugin holds the person's. It refuses to post and says so rather than failing
   quietly.

`SOCIAL_OAUTH_*` variables keep their names and still work: they are read for
any network with no row in the admin, so nothing has to move at once. Setting a
network up in Social → Settings takes over from its variables for that network
only.

Five of the nine — Facebook, Instagram, Threads, Pinterest, Google Business —
*download* media from your site rather than being handed it, so posts carrying
images or video need `PUBLIC_URL` to be an address they can reach. The settings
screen says so when it is not, rather than letting five publishers fail with
what reads as the network's fault.

**If you set `S3_PUBLIC_URL`**, serving the bucket directly takes media reads out
of `/media/file`, and two things follow. A soft-deleted item keeps answering on
its old URL until it is purged — the delivery API stops listing it either way.
And the URL becomes the whole of the access control, exactly as it already is on
the local driver, which is why keys carry 8 bytes of randomness. Grant the bucket
anonymous `GetObject` and never `ListBucket`.

## 1.1.1 — 2026-08-06

The documentation moved to its own home at **inkling.wess.dev**, alongside a new
School — a knowledge base for people who do not work in software.

### Changed

- Every documentation link points at `inkling.wess.dev` rather than
  `wess.io/inkling`. The old address still works and still publishes on push;
  the pages carry a canonical link to the new one so search engines settle on a
  single home.
- The documentation pages link to the School, and vice versa.

### Note for anyone running the site

`inkling.wess.dev` serves the guide, reference, tutorials and `llms.txt`
straight out of `node_modules/inkling/docs` — the copy that ships in the package
it has pinned. Pin v1.1.1 and you are reading v1.1.1's reference, with no sync
step to forget and no second copy to drift.

The consequence is worth stating: a documentation change now needs a release to
reach that site. That is the intended trade for a reference that always matches
the code it describes.

## 1.1.0 — 2026-08-06

Groundwork for templates. Nothing in this release changes how an existing site
behaves — `createInkling()` does not import any of it, and a site that does not
ask for a template will not notice it exists.

### Added

- **`templates/`, the registry.** One directory per design, one validated
  manifest in each. Shaped like a registry rather than a directory because a
  template eventually arrives from somewhere other than this repository, and
  discovering that shape afterwards means rewriting every template that already
  exists.
- **`src/theme/`, the compiler.** Typed tokens in, CSS custom properties out.
  Values are checked against the token's own type rather than scrubbed for
  dangerous characters: a colour that must match a colour pattern cannot be a
  URL, and `url(https://…)` in a token used for a background is an outbound
  request on every page load that no amount of character stripping makes safe.
  Anything failing its type falls back to the template's default, because
  rendering in the designed colours beats rendering a blank page.
- **Five designs, fifteen palettes.** Quarto, Foundry, Orchard, Lattice, and
  Aster — each declaring a different structure, not a different palette, and
  each carrying three palettes of its own. Three are dark. A test asserts no two
  share a layout signature or a type pairing.
- **`bun run templates`** renders every design in every palette to one page.
  Its markup branches on layout and on nothing else, which is what proves a
  section can work in all five.
- **`docs/TEMPLATES.md`** — the design this is the first phase of, including why
  templates must be data rather than code, and where the renderer will mount.

### Note

There is no renderer yet, deliberately. This is the theme and layout layer, and
it exists to make the designs real enough to judge before the expensive part
gets built.

## 1.0.0 — 2026-08-06

The version number is the news. Everything below has been in daily use across
two production sites for weeks; what changed is that the last thing standing
between Inkling and a version anyone could depend on is gone.

While Inkling was `0.x` a minor covered breaking changes. From here it does not:
the delivery API, `createInkling()`, the plugin interface, and the shape of a
content type are the public surface, and breaking any of them takes a major.

### Added

- **`bun run password`** — set a user's password from the machine that runs the
  database. This was the last real gap: a site with one owner who has lost their
  password had no way back in. `POST /auth/password` needs the current password,
  changing someone else's needs a second admin, and setup closes permanently
  once the first user exists. Run it with no arguments to list the accounts.
  It revokes every session for that account and records the reset in the audit
  trail as `auth.password.reset` with `via: cli`, because a password change with
  no browser session behind it is the interesting kind.

### Changed

- The documentation site dropped the film framing it inherited from an early
  design direction — reels, frame numbers, "on air", "the cutting room". Inkling
  is a publishing tool, and the strip on the homepage was always showing an
  editorial workflow rather than a filmstrip; it says so now.

### Note

The first person through the door still becomes the owner, and the setup route
still closes permanently behind them. That behaviour is unchanged and is now
covered end to end.

## 0.7.0 — 2026-08-06

### Added

- **Social accounts.** The `social` plugin can authorize one account per network
  — LinkedIn, X, Facebook, Instagram, Threads, TikTok, YouTube, Pinterest,
  Google Business — over authorization-code + PKCE. Tokens are sealed into a new
  `social_accounts` table with the same AES-GCM helper the AI credentials use,
  renewed inside a five-minute window, and marked for reconnection when a
  refresh fails. Clients come from `SOCIAL_OAUTH_<NETWORK>_CLIENT_ID` and
  friends; a network with none set says so rather than offering a button that
  dead-ends. **Nothing is posted to any network yet** — the per-network publish
  call is deliberately not built until it can be built one network at a time.
- **A `connections` panel kind** for plugins: a list of authorizable accounts
  where the admin owns connect / disconnect and the plugin owns every word on a
  row. `ctx.adminBase` was added for its OAuth return leg, which is a top-level
  navigation and has to land somewhere in the admin.
- **`src/oauth/`** — the authorization-code + PKCE machinery, extracted so the
  AI and social flows share one implementation instead of two. `src/ai/oauth.ts`
  is now a thin adapter over it and its public API is unchanged.
- **Help hints across the admin.** A `?` beside eight screen headings and
  fourteen field labels, on hover, focus, and tap, with the tooltip always in the
  DOM and referenced by `aria-describedby` so assistive technology reads it
  regardless of visibility.

### Fixed

- **Relative times never looked forward.** `ago()` subtracted in one direction
  only, so any future moment — a scheduled publish, a key's expiry, when a
  social token renews — landed under the first threshold and rendered as "just
  now". Worse than a wrong number, because it read as fine.
- **"Open" on the plugins screen went somewhere unannounced.** It jumped to
  `panels[0]`, which for `social` meant the Calendar. It now prefers the
  settings panel and is labelled with its destination.
- Empty grid slots on the docs site showed the backing colour as panel-sized
  rectangles; the homepage's inline script never ran at all, killed by an ASI
  hazard between two IIFEs; and several other layout faults only a browser could
  have found.

### Changed

- **`atlas` is pinned to a commit** rather than tracking `main`. A tag that
  depends on a moving branch is not reproducible, which undercuts the whole
  reason sites pin Inkling by tag.
- The documentation site was redesigned twice — first away from the serif-and-
  editorial look it shared with the sites Inkling powers, then into mid-century
  modern with atomic-age detail. `docs/` publishes to the site on push.

## 0.6.0 — 2026-08-05

### Added

- **Inky rides along.** The agent now sits in the corner of every admin screen
  and knows which screen that is, so "make this shorter" resolves without naming
  the entry.
- **A bubble for your visitors.** The `assistant` plugin ships a self-contained
  widget — one script tag, rendered into a shadow root — answering from
  published content only, under guardrails you write. Off until enabled, and it
  answers nobody until you list the origins allowed to embed it.
- Inky gained `propose_type_create` and `propose_entry_status`, so it can shape
  a new kind of page and move something between draft and published. Every tool
  is still a read or an inert proposal.

### Fixed

- **Plugin stats and table panels were all broken.** `/api/ext/…` matched no
  route, fell through to the SPA, and returned admin HTML with a 200.
- `widget.js` was served as `text/plain`, which `nosniff` makes a browser refuse
  outright.
- Plugin nav highlighting matched on the plugin rather than the panel, so every
  panel of a plugin lit at once.

## 0.5.0 — 2026-08-05

- **Ollama Cloud** as its own provider, with a fixed endpoint so no URL can be
  mistyped. Previously it was reachable only by pointing the local Ollama entry
  at a remote base URL, which produced `/v1/v1/chat/completions` and a 404.
- A provider that answers but refuses now says so, naming the model, instead of
  returning an empty success.

## 0.4.0 — 2026-08-05

- **Prompt caching for Inky**: the tool schemas and system prompt are marked
  once and at most two breakpoints roll across the transcript.
- `bun run sites` — health and deployed version for every site, exiting non-zero
  if anything is down or behind, so it can gate a deploy.
- `RELEASING.md`, which is how a release ships and how it reaches a site.

## 0.3.0 — 2026-08-05

- **Inky**, the agent with the run of the site: it reads types, entries, media,
  settings, and menus, then proposes changes the admin renders as a diff.
- **Provider OAuth**, for operators who would rather authorize an account than
  paste a key that never expires.
- **`createInkling()`** — Inkling mounts inside another Bun process and returns
  a handler rather than owning a port.
- **The `social` plugin**: clients, channels, campaigns, and posts as ordinary
  content types, with a queue, a calendar, and a performance report over them.
- **Atlas is imported as `atlas/<pkg>`**, not `@atlas/<pkg>`. Bun does not apply
  a consuming project's tsconfig paths to files under `node_modules`, so the
  aliased spelling resolved in this repo and failed the moment a site installed
  Inkling from GitHub.
- The documentation site, published from CI.

## 0.2.0 — 2026-07-30

The first tagged release: content types and 18 field types, entries with
revisions and scheduling, media, taxonomies, menus, settings, the delivery API,
realtime, previews, webhooks, audit, API keys, roles, the plugin system, and the
editorial assistant.
