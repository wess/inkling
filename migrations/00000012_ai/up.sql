-- Operator-supplied AI provider credentials. The secret is stored encrypted
-- (AES-GCM, key derived from SECRET) rather than in plaintext, and is never
-- returned by the API — `hint` exists so the UI can tell two keys apart without
-- being able to reconstruct either. `settings` is deliberately not used for
-- these: that table is read wholesale by readScope() and surfaced to plugin
-- panels, which is exactly the wrong shape for a secret.
CREATE TABLE IF NOT EXISTS ai_credentials (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  label        TEXT NOT NULL,
  model        TEXT NOT NULL,
  base_url     TEXT,
  ciphertext   TEXT NOT NULL,
  iv           TEXT NOT NULL,
  hint         TEXT NOT NULL,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS ai_credentials_provider_idx ON ai_credentials (provider);
CREATE INDEX IF NOT EXISTS ai_credentials_default_idx ON ai_credentials (is_default, revoked_at);
