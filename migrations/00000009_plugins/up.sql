-- Installed-plugin state. The plugin's code lives on disk under PLUGIN_DIR;
-- this table records which are enabled and at what version, so a version bump
-- on disk can trigger the plugin's own migrations on next boot.
-- Plugin settings live in `settings` under scope = plugin name.
CREATE TABLE IF NOT EXISTS plugins (
  name         TEXT PRIMARY KEY,
  version      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
