-- Agent keys: a credential for a machine working this site through the admin
-- API, narrower than the account behind it and revocable on its own.
--
-- The thing this replaces is an MCP server holding an owner's email and
-- password. That is not a scoped credential — it is the account, and anything
-- holding it can mint delivery keys, register webhooks, connect a social
-- account, or create a second owner, whatever the tool list in front of it
-- happens to expose. Revoking it means changing the password, which signs every
-- person out too.
--
-- So: only the SHA-256 is stored, the plaintext is shown once, `grants` is the
-- explicit list of capability names (src/auth/roles.ts) the key may exercise,
-- and the effective permission is always the intersection of that list with the
-- live role of `user_id`. Demote the account and the key narrows with it.
--
-- `expires_at` is NOT NULL on purpose. A machine credential that never lapses
-- is one nobody ever revisits.
CREATE TABLE IF NOT EXISTS agent_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  hashed_key   TEXT NOT NULL UNIQUE,
  -- Enough to recognize the key in a list, far too little to rebuild it.
  prefix       TEXT NOT NULL,
  grants       TEXT NOT NULL DEFAULT '[]',
  -- Whose authority the key borrows, and who the audit trail credits. A key
  -- always acts as the account that minted it: letting one name another account
  -- would be a way to launder authority through a credential.
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  -- Kept alongside last_used_at because "this key was used from somewhere new"
  -- is the one signal an operator can act on without reading the audit table.
  last_ip      TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS agent_keys_hashed_idx ON agent_keys (hashed_key);
CREATE INDEX IF NOT EXISTS agent_keys_user_idx ON agent_keys (user_id);
