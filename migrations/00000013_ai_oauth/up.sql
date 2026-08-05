-- A second way to connect a provider: OAuth, for operators who would rather
-- authorize an account than paste a long-lived key.
--
-- The access token lands in the existing `ciphertext`/`iv` columns, so every
-- reader that already opens a credential keeps working without a branch. What
-- OAuth adds is the part a key does not have: something to refresh with, and a
-- moment at which the current token stops working.
--
-- `account` is whatever the provider called the thing that was authorized — an
-- email, an organization. It exists so two connections to the same provider can
-- be told apart by a human, which `hint` cannot do when the secret is a token
-- nobody has ever seen.
ALTER TABLE ai_credentials ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'key';
ALTER TABLE ai_credentials ADD COLUMN refresh_ciphertext TEXT;
ALTER TABLE ai_credentials ADD COLUMN refresh_iv TEXT;
ALTER TABLE ai_credentials ADD COLUMN expires_at TEXT;
ALTER TABLE ai_credentials ADD COLUMN scope TEXT;
ALTER TABLE ai_credentials ADD COLUMN account TEXT;
