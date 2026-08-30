-- Backend Integration Step 5: first-party authentication/session lifecycle.
-- Apply after the base users table and Step 3 migrations.

BEGIN;

CREATE TABLE IF NOT EXISTS auth_sessions (
    auth_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    access_token_hash TEXT NOT NULL UNIQUE,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    previous_refresh_token_hash TEXT,
    previous_refresh_valid_until TIMESTAMPTZ,
    access_expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS previous_refresh_token_hash TEXT;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS previous_refresh_valid_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS auth_sessions_previous_refresh_idx
    ON auth_sessions(previous_refresh_token_hash)
    WHERE previous_refresh_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
    ON auth_sessions(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_active_user_idx
    ON auth_sessions(user_id,refresh_expires_at DESC)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS auth_sessions_device_idx
    ON auth_sessions(user_id,device_id)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_password_resets (
    reset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_password_resets_user_idx
    ON auth_password_resets(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS auth_password_resets_active_idx
    ON auth_password_resets(expires_at)
    WHERE consumed_at IS NULL;

COMMIT;
