-- Delivery API keys. Only the SHA-256 hash is stored; the plaintext is shown
-- exactly once at creation. `prefix` is the leading public fragment kept so the
-- UI can identify a key in a list without being able to reconstruct it.
-- `scopes` is a JSON array of content-type names, or [] meaning "all types".
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  hashed_key   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '[]',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS api_keys_hashed_idx ON api_keys (hashed_key);
