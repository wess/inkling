ALTER TABLE ai_credentials DROP COLUMN account;
ALTER TABLE ai_credentials DROP COLUMN scope;
ALTER TABLE ai_credentials DROP COLUMN expires_at;
ALTER TABLE ai_credentials DROP COLUMN refresh_iv;
ALTER TABLE ai_credentials DROP COLUMN refresh_ciphertext;
ALTER TABLE ai_credentials DROP COLUMN auth_kind;
