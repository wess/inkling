-- Plugin-owned table, recorded as "plugin:analytics/00000001_events".
-- Same portability rules as core: TEXT ids, TEXT ISO timestamps, TEXT JSON.
--
-- `day` duplicates the date half of `created_at` on purpose. Grouping by day is
-- what every report here does, and the function that extracts a date from a
-- timestamp is spelled differently on each dialect (`to_char` vs `strftime`).
-- Storing the bucket makes every GROUP BY and the retention delete portable.
--
-- There is no `ip` column, and there is deliberately no way to add one: the
-- address is hashed into `visitor` at ingest and discarded.
CREATE TABLE IF NOT EXISTS analytics_events (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  referrer   TEXT NOT NULL DEFAULT '',
  visitor    TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  day        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS analytics_events_day_idx ON analytics_events (day);
CREATE INDEX IF NOT EXISTS analytics_events_path_idx ON analytics_events (path, day);
CREATE INDEX IF NOT EXISTS analytics_events_name_idx ON analytics_events (name, day);
