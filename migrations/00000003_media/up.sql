CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  url         TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL DEFAULT 0,
  width       INTEGER,
  height      INTEGER,
  alt         TEXT,
  caption     TEXT,
  folder      TEXT,
  uploaded_by TEXT,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE INDEX IF NOT EXISTS media_created_idx ON media (created_at);
CREATE INDEX IF NOT EXISTS media_folder_idx ON media (folder);
CREATE INDEX IF NOT EXISTS media_deleted_idx ON media (deleted_at);
