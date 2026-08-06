-- The accounts a client posts from, and the tokens that let us do it.
--
-- Not a content type, for the same reason AI credentials are not settings: this
-- table holds sealed secrets, and every content type in Inkling is readable
-- through an editor screen, a revision, a search index, and the delivery API. A
-- refresh token has no business in any of those.
--
-- `access_ct` / `access_iv` and the refresh pair are AES-GCM under a key derived
-- from SECRET (src/ai/secrets.ts). Rotating SECRET therefore breaks every stored
-- token, which reads as "reconnect this account" — the same failure an expired
-- grant produces, and one an operator has already met with AI providers.
--
-- Same portability rules as core: TEXT ids, TEXT ISO timestamps, snake_case
-- columns.
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
  -- panel, and it holds the provider's own words rather than our summary.
  error         TEXT,
  connected_by  TEXT,
  connected_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- One live connection per network per client. A reconnect updates the row it
-- finds rather than leaving the old token behind to expire quietly.
CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_slot_idx ON social_accounts (network, client_id);
