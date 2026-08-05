-- Plugin-owned table, recorded as "plugin:social/00000001_results" and rolled
-- back when the plugin is uninstalled.
--
-- The one thing the content types cannot hold. A post is a document and gets an
-- entry; its results are a time series that keeps arriving after the document
-- stops changing, and storing them as fields would mean a new revision of the
-- copy every time a number moved.
--
-- Same portability rules as core: TEXT ids, TEXT ISO timestamps, snake_case
-- columns, money in whole cents so no dialect has to agree about decimals.
CREATE TABLE IF NOT EXISTS social_results (
  id          TEXT PRIMARY KEY,
  client_id   TEXT,
  post_id     TEXT,
  channel_id  TEXT,
  network     TEXT NOT NULL,
  day         TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  engagements INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  follows     INTEGER NOT NULL DEFAULT 0,
  spend_cents INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS social_results_day_idx ON social_results (day, network);
CREATE INDEX IF NOT EXISTS social_results_post_idx ON social_results (post_id, day);
CREATE INDEX IF NOT EXISTS social_results_client_idx ON social_results (client_id, day);
