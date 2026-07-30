-- `events` is a JSON array of event names ('entry.published', 'media.uploaded', …).
-- Deliveries are HMAC-SHA256 signed with `secret` and sent best-effort.
CREATE TABLE IF NOT EXISTS webhooks (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  events        TEXT NOT NULL DEFAULT '[]',
  secret        TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_status   INTEGER,
  last_fired_at TEXT
);

CREATE INDEX IF NOT EXISTS webhooks_active_idx ON webhooks (active);
