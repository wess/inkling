CREATE TABLE IF NOT EXISTS taxonomies (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  hierarchical INTEGER NOT NULL DEFAULT 0,
  owner_plugin TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terms (
  id          TEXT PRIMARY KEY,
  taxonomy_id TEXT NOT NULL REFERENCES taxonomies (id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES terms (id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  label       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (taxonomy_id, slug)
);

CREATE INDEX IF NOT EXISTS terms_taxonomy_idx ON terms (taxonomy_id);
CREATE INDEX IF NOT EXISTS terms_parent_idx ON terms (parent_id);

CREATE TABLE IF NOT EXISTS entry_terms (
  entry_id TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  term_id  TEXT NOT NULL REFERENCES terms (id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, term_id)
);

CREATE INDEX IF NOT EXISTS entry_terms_term_idx ON entry_terms (term_id);
