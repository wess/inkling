-- `kind` is 'collection' (many entries: posts, products) or 'single'
-- (exactly one entry: the homepage, site-wide hours). `fields` holds the
-- ordered field definitions as JSON — see src/fields for the shape.
-- `owner_plugin` is the plugin name when a plugin declared the type; core
-- types leave it NULL. Disabling a plugin uses this to find what to retire.
CREATE TABLE IF NOT EXISTS content_types (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  plural_label TEXT NOT NULL,
  description  TEXT,
  kind         TEXT NOT NULL DEFAULT 'collection',
  fields       TEXT NOT NULL DEFAULT '[]',
  icon         TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  owner_plugin TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS content_types_plugin_idx ON content_types (owner_plugin);

CREATE TABLE IF NOT EXISTS entries (
  id              TEXT PRIMARY KEY,
  content_type_id TEXT NOT NULL REFERENCES content_types (id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  data            TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'draft',
  locale          TEXT NOT NULL DEFAULT 'en',
  author_id       TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  published_at    TEXT,
  scheduled_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

-- Slugs are unique per type per locale, but only among live rows. Soft-deleted
-- entries keep their slug so restore is lossless; a partial index would be the
-- Postgres way to express that, but partial indexes are not portable, so
-- uniqueness is enforced in src/entries alongside the deleted_at filter.
CREATE INDEX IF NOT EXISTS entries_type_slug_idx ON entries (content_type_id, locale, slug);
CREATE INDEX IF NOT EXISTS entries_status_idx ON entries (status, published_at);
CREATE INDEX IF NOT EXISTS entries_deleted_idx ON entries (deleted_at);
CREATE INDEX IF NOT EXISTS entries_scheduled_idx ON entries (scheduled_at);

CREATE TABLE IF NOT EXISTS revisions (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'draft',
  author_id  TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS revisions_entry_idx ON revisions (entry_id, created_at);
