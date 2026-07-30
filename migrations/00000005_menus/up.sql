-- `items` is a JSON array of nodes: { label, url?, entryId?, target?, children[] }.
-- Menus are small and always read whole, so nesting stays in the document
-- rather than becoming a self-referential table.
CREATE TABLE IF NOT EXISTS menus (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  items      TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
