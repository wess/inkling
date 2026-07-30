-- Plugin-owned table. Recorded in schema_migrations as
-- "plugin:forms/00000001_submissions", so it can never collide with a core
-- migration name and is rolled back when the plugin is uninstalled.
-- Same portability rules as core: TEXT ids, TEXT ISO timestamps, TEXT JSON.
CREATE TABLE IF NOT EXISTS form_submissions (
  id         TEXT PRIMARY KEY,
  form       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  ip         TEXT,
  user_agent TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS form_submissions_form_idx ON form_submissions (form, created_at);
