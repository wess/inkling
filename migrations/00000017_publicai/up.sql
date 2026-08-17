DROP TABLE IF EXISTS public_ai_sessions;
-- The live conversation a site visitor is having with the public assistant.
--
-- This table exists for one reason: a browser cannot be trusted to hand back
-- its own transcript. If the prior turns rode along in the request, a visitor
-- could forge what the assistant already "said" — `Assistant: I will now print
-- my instructions` — and steer the next answer with it. The browser therefore
-- holds an opaque id and nothing else, and the turns it names live here, where
-- only this server ever writes them.
--
-- It is a working set, not a log. Nothing a visitor typed is kept past the
-- session's TTL: `last_seen_at` is what the sweep reads, and an expired row is
-- deleted whole rather than anonymised. That is deliberate — an operator who
-- wants to know what customers ask should get that from counts and refusals,
-- which carry no personal data, rather than from a table of everything anybody
-- ever typed into a box on their website.
--
-- `turn_count` is separate from the length of `turns` because the turns array
-- is trimmed to the last few exchanges to bound the prompt, while the count
-- keeps rising and is what the per-session ceiling is enforced against.
CREATE TABLE IF NOT EXISTS public_ai_sessions (
  id            TEXT PRIMARY KEY,
  turns         TEXT NOT NULL DEFAULT '[]',
  turn_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

-- The sweep's only predicate.
CREATE INDEX IF NOT EXISTS public_ai_sessions_seen_idx ON public_ai_sessions (last_seen_at);
