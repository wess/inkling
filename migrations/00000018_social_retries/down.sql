DROP INDEX IF EXISTS social_targets_retry_idx;
ALTER TABLE social_targets DROP COLUMN next_attempt_at;
ALTER TABLE social_targets DROP COLUMN error_code;
