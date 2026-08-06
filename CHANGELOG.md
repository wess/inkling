# Changelog

Inkling is consumed as a git dependency and pinned by tag, so this file exists
for one reader: someone deciding whether to move a site from one tag to the
next. Entries say what changed and what it means for an install, not what was
refactored.

Dates are release dates. While Inkling is `0.x`, a minor covers new surface
*and* breaking changes; a patch is fixes alone.

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
