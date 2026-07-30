-- One table for core settings and plugin settings. `scope` is 'site' for core
-- keys or the plugin name for plugin-owned ones, so plugin settings can never
-- collide with core keys and are removed with the plugin. `value` is JSON so a
-- setting can be a string, number, boolean, or small object.
CREATE TABLE IF NOT EXISTS settings (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
