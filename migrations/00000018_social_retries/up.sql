ALTER TABLE social_targets ADD COLUMN error_code TEXT;
ALTER TABLE social_targets ADD COLUMN next_attempt_at TEXT;

CREATE INDEX social_targets_retry_idx ON social_targets (status, next_attempt_at);
