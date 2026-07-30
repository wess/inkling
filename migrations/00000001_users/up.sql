-- Portable across Postgres and SQLite. See docs/ARCHITECTURE.md:
-- TEXT uuid primary keys, TEXT ISO-8601 timestamps, INTEGER 0/1 booleans,
-- TEXT columns holding JSON. No SERIAL, TIMESTAMPTZ, BOOLEAN, NOW(), or JSONB.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'editor',
  password_hash TEXT NOT NULL,
  avatar_id     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
CREATE INDEX IF NOT EXISTS users_deleted_idx ON users (deleted_at);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
