-- Social media management, moved into core.
--
-- It began as the `social` plugin's connections half, which could authorize an
-- account but never post with it — a plugin cannot own the two things
-- publishing needs. The first is a background sweep: a plugin's setInterval
-- keeps firing after the plugin is disabled, so "stop posting" would not stop
-- posting. The second is a composer, and the admin bundle is built before any
-- plugin exists, so a plugin can only describe panels the SPA already knows how
-- to draw. Neither is a limitation worth working around for the feature an
-- operator opens Inkling for on a Monday morning.
--
-- `social_accounts` is deliberately created with the exact shape the plugin's
-- own migration used, and CREATE TABLE IF NOT EXISTS: an install that already
-- connected accounts keeps its rows and its tokens, and a fresh one gets the
-- table from here. The plugin's copy of this migration is gone, so only one
-- place creates it now.
CREATE TABLE IF NOT EXISTS social_accounts (
  id            TEXT PRIMARY KEY,
  network       TEXT NOT NULL,
  -- Which client this account belongs to. Empty string rather than NULL for
  -- "the operator's own", because both dialects treat NULLs as distinct in a
  -- unique index — a nullable column here would let the same network be
  -- connected twice and neither row would be wrong.
  client_id     TEXT NOT NULL DEFAULT '',
  account_name  TEXT,
  account_id    TEXT,
  scope         TEXT,
  access_ct     TEXT NOT NULL,
  access_iv     TEXT NOT NULL,
  refresh_ct    TEXT,
  refresh_iv    TEXT,
  expires_at    TEXT,
  -- Set when a refresh fails. Its presence is what turns the row amber in the
  -- panel, and it holds the network's own words rather than our summary.
  error         TEXT,
  connected_by  TEXT,
  connected_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One live connection per network per client. A reconnect updates the row it
-- finds rather than leaving the old token behind to expire quietly.
CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_slot_idx ON social_accounts (network, client_id);

-- Added rather than declared above so both paths converge on the same table:
-- an existing install runs the ALTER against the plugin's table, a fresh one
-- runs it against the one just created.
--
-- What goes in here is per-network detail with no cross-network meaning — a
-- Facebook page id and its name, a YouTube channel id, an avatar to draw. A
-- column each would be a column per network we ever add.
ALTER TABLE social_accounts ADD COLUMN meta TEXT;

-- A composed post, before it belongs to any one network.
--
-- Not a content type, though it was one in the plugin. A content type buys the
-- editor, revisions, and the delivery API, and a post wants none of the three:
-- it is written once and then it is *sent*, and the interesting state after
-- that is per-network — posted to X, refused by TikTok — which a single
-- `status` on a single row cannot hold. `social_targets` is that state, and it
-- is the reason this is a table.
CREATE TABLE IF NOT EXISTS social_posts (
  id            TEXT PRIMARY KEY,
  -- An internal label, for finding the post in a list. Falls back to the first
  -- words of the caption when nobody typed one.
  title         TEXT NOT NULL DEFAULT '',
  caption       TEXT NOT NULL DEFAULT '',
  link          TEXT,
  -- Ordered media ids, JSON. TEXT rather than JSONB so both dialects hand back
  -- the same thing — see src/json.
  media         TEXT NOT NULL DEFAULT '[]',
  -- draft | scheduled | publishing | posted | partial | failed | canceled.
  -- "partial" is the one worth naming: some networks took it and some did not,
  -- which is neither success nor failure and is the most common real outcome.
  status        TEXT NOT NULL DEFAULT 'draft',
  scheduled_at  TEXT,
  published_at  TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

-- The sweep's only query: what is due. Ordered by the same column it filters
-- on, so it reads the front of the index and stops.
CREATE INDEX IF NOT EXISTS social_posts_due_idx ON social_posts (status, scheduled_at);
CREATE INDEX IF NOT EXISTS social_posts_recent_idx ON social_posts (deleted_at, updated_at);

-- One row per (post, account): the copy that network gets, what it did with
-- it, and where it landed.
--
-- `network` is denormalized on purpose. A disconnected account takes its row
-- with it, and a target that could no longer say which network it went out on
-- would make the history it exists to keep unreadable.
CREATE TABLE IF NOT EXISTS social_targets (
  id            TEXT PRIMARY KEY,
  post_id       TEXT NOT NULL,
  account_id    TEXT,
  network       TEXT NOT NULL,
  -- Per-network copy. NULL means "use the post's caption" rather than "empty",
  -- so a post whose caption is later edited still updates every network that
  -- did not override it.
  caption       TEXT,
  -- Per-network fields with no equivalent anywhere else: a YouTube title and
  -- privacy status, a TikTok privacy level, whether comments are allowed.
  options       TEXT NOT NULL DEFAULT '{}',
  -- pending | publishing | posted | failed | skipped
  status        TEXT NOT NULL DEFAULT 'pending',
  remote_id     TEXT,
  remote_url    TEXT,
  -- The network's own words. Ours would be a summary of a message the operator
  -- needs verbatim to fix — "the video is too long" is the whole diagnosis.
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  posted_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS social_targets_post_idx ON social_targets (post_id);
CREATE INDEX IF NOT EXISTS social_targets_account_idx ON social_targets (account_id, posted_at);
