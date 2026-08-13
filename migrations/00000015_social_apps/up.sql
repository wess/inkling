-- The developer app registered with each network, set up in the admin rather
-- than in the environment.
--
-- It started in the environment because an OAuth client is registered *with the
-- network* against a redirect URI, so there is nothing self-hosted software can
-- ship instead. That reasoning is about where the value comes from, not about
-- where it is typed — and requiring a redeploy to turn on a network is a worse
-- answer than a form, especially for the operator who has nine of these to work
-- through and gets them approved one at a time over a fortnight.
--
-- `client_secret` is sealed rather than stored, the same AES-GCM under SECRET
-- that AI credentials and social tokens use. It is emphatically not a `settings`
-- row: `readScope()` reads that table wholesale and hands it to plugin panels,
-- which is the wrong shape for a secret. `secret_hint` is the last four
-- characters, so two can be told apart without either being shown.
--
-- Environment variables still work and are read when a network has no row here,
-- so an install that configured them keeps running untouched.
CREATE TABLE IF NOT EXISTS social_apps (
  network       TEXT PRIMARY KEY,
  -- Set up and switched on are two different things. An operator mid-way
  -- through a network's review process wants the credentials saved and the
  -- network not yet offered.
  enabled       INTEGER NOT NULL DEFAULT 1,
  client_id     TEXT NOT NULL DEFAULT '',
  secret_ct     TEXT,
  secret_iv     TEXT,
  secret_hint   TEXT,
  -- Overrides for what we ship per network. A URL moves, or an operator is on a
  -- regional endpoint, and neither should need a release.
  authorize_url TEXT,
  token_url     TEXT,
  scopes        TEXT,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL
);
