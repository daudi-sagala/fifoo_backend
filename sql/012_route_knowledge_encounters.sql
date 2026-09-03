BEGIN;

CREATE TABLE IF NOT EXISTS user_route_knowledge (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    knowledge_key TEXT NOT NULL,
    knowledge_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
    source TEXT NOT NULL DEFAULT 'road_encounter_self_report',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,knowledge_key)
);

CREATE TABLE IF NOT EXISTS route_knowledge_encounters (
    encounter_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    map_date DATE,
    question_key TEXT NOT NULL,
    question_version INTEGER NOT NULL DEFAULT 1 CHECK (question_version > 0),
    encounter_style TEXT NOT NULL
        CHECK (encounter_style IN ('road_encounter','scout_report','quick_duel')),
    status TEXT NOT NULL DEFAULT 'offered'
        CHECK (status IN ('offered','answered','deferred','dismissed','expired')),
    question_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    trigger_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    answer_data JSONB,
    reward_xp INTEGER NOT NULL DEFAULT 0 CHECK (reward_xp >= 0),
    presented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    deferred_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS route_knowledge_encounters_user_time_idx
    ON route_knowledge_encounters(user_id,presented_at DESC);
CREATE INDEX IF NOT EXISTS route_knowledge_encounters_user_status_idx
    ON route_knowledge_encounters(user_id,status,updated_at DESC);

COMMIT;
