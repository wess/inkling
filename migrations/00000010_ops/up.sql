CREATE TABLE IF NOT EXISTS audit_events (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  event      TEXT NOT NULL,
  metadata   TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_user_idx ON audit_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS audit_events_event_idx ON audit_events (event, created_at);

-- window_started_at is TEXT ISO here rather than the TIMESTAMPTZ/INTEGER split
-- @atlas/security's createDbRateLimit expects, so src/security owns the limiter
-- and keeps the whole schema on one portable convention.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket            TEXT PRIMARY KEY,
  count             INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL
);
