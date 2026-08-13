DROP TABLE IF EXISTS social_targets;
DROP TABLE IF EXISTS social_posts;
-- Dropped rather than left standing, even though an install that connected an
-- account under the plugin had this table before this migration ran. The
-- plugin's copy of it is gone, so core is its only owner now — and a rollback
-- that left an orphan table behind would make the next `up` a no-op against a
-- shape nothing created.
DROP TABLE IF EXISTS social_accounts;
