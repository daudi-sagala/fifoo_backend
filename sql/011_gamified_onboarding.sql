BEGIN;

CREATE TABLE IF NOT EXISTS user_game_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    onboarding_status TEXT NOT NULL DEFAULT 'completed_legacy'
        CHECK (onboarding_status IN ('not_started','in_progress','preview_ready','completed','completed_legacy')),
    onboarding_version INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_version > 0),
    main_quest TEXT,
    player_style TEXT,
    difficulty TEXT,
    current_weight_lb DOUBLE PRECISION CHECK (current_weight_lb IS NULL OR current_weight_lb BETWEEN 70 AND 700),
    goal_weight_lb DOUBLE PRECISION CHECK (goal_weight_lb IS NULL OR goal_weight_lb BETWEEN 70 AND 700),
    target_pace_lb_per_week DOUBLE PRECISION CHECK (target_pace_lb_per_week IS NULL OR target_pace_lb_per_week BETWEEN 0.1 AND 2.0),
    primary_motivation TEXT,
    preferred_intervention_intensity TEXT,
    onboarding_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing accounts should not unexpectedly be forced through a new-user flow.
INSERT INTO user_game_profiles(user_id,onboarding_status,onboarding_version,onboarding_completed_at)
SELECT user_id,'completed_legacy',1,NOW() FROM users
ON CONFLICT(user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS onboarding_sessions (
    onboarding_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    onboarding_version INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_version > 0),
    current_stage TEXT NOT NULL DEFAULT 'player_style',
    status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress','preview_ready','completed','abandoned','superseded')),
    session_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_route_map_date DATE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id,onboarding_version)
);

CREATE INDEX IF NOT EXISTS onboarding_sessions_user_updated_idx
    ON onboarding_sessions(user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS user_game_obstacles (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    obstacle_key TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 10),
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.60 CHECK (confidence BETWEEN 0 AND 1),
    source TEXT NOT NULL DEFAULT 'onboarding_self_report',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,obstacle_key)
);

CREATE TABLE IF NOT EXISTS user_game_powerups (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    powerup_key TEXT NOT NULL,
    preference_strength DOUBLE PRECISION NOT NULL DEFAULT 0.70 CHECK (preference_strength BETWEEN 0 AND 1),
    source TEXT NOT NULL DEFAULT 'onboarding_self_report',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,powerup_key)
);

CREATE TABLE IF NOT EXISTS user_schedule_preferences (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    schedule_key TEXT NOT NULL,
    clock_time TIME,
    start_time TIME,
    end_time TIME,
    flexibility_minutes INTEGER NOT NULL DEFAULT 30 CHECK (flexibility_minutes BETWEEN 0 AND 720),
    is_fixed BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT NOT NULL DEFAULT 'onboarding_self_report',
    preference_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,schedule_key)
);

CREATE TABLE IF NOT EXISTS user_game_progress (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    total_xp INTEGER NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
    level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
    current_streak INTEGER NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
    best_streak INTEGER NOT NULL DEFAULT 0 CHECK (best_streak >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO user_game_progress(user_id)
SELECT user_id FROM users
ON CONFLICT(user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS game_xp_ledger (
    xp_ledger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT,
    xp INTEGER NOT NULL CHECK (xp <> 0),
    reason TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS game_xp_ledger_user_time_idx
    ON game_xp_ledger(user_id,occurred_at DESC);

COMMIT;
