CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  hashed_code    TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  challenge      TEXT NOT NULL,
  resource       TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

ALTER TABLE agent_keys ADD COLUMN audience TEXT;
