-- Plugin-owned table, recorded as "plugin:google/00000001_connection".
-- Same portability rules as core: TEXT ids, TEXT ISO timestamps, TEXT JSON.
--
-- At most one row. A site has one Google account behind it, and a second row
-- would mean every report had to ask which — so connecting again replaces what
-- is there rather than adding to it.
--
-- Tokens are sealed with the same AES-GCM as every other stored credential, so
-- this table holds ciphertext and an IV per token and never a usable one.
-- `scope` is what Google actually granted, which is not always what was asked
-- for: someone can untick Ads on the consent screen, and the Ads panel has to
-- be able to say so rather than failing with a permission error.
CREATE TABLE IF NOT EXISTS google_connections (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  account      TEXT,
  scope        TEXT,
  access_ct    TEXT NOT NULL,
  access_iv    TEXT NOT NULL,
  refresh_ct   TEXT,
  refresh_iv   TEXT,
  expires_at   TEXT,
  error        TEXT,
  connected_by TEXT,
  connected_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  meta         TEXT NOT NULL DEFAULT '{}'
);
