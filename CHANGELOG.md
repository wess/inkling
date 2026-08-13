# Changelog

Inkling is consumed as a git dependency and pinned by tag, so this file exists
for one reader: someone deciding whether to move a site from one tag to the
next. Entries say what changed and what it means for an install, not what was
refactored.

Dates are release dates. From 1.0 this is semver: a major for a breaking change
to the delivery API, `createInkling()`, the plugin interface, or the shape of a
content type; a minor for new surface; a patch for fixes alone.

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
