-- Pass 5.55: idempotent backend-generated daily path bookkeeping.
-- Tracks only nodes created by the automatic generator; manually created user
-- nodes remain untouched when rules are regenerated.

BEGIN;

CREATE TABLE IF NOT EXISTS day_map_generation_runs (
    day_map_id UUID PRIMARY KEY REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    generator_name TEXT NOT NULL,
    generator_version INTEGER NOT NULL CHECK (generator_version > 0),
    rules_hash TEXT NOT NULL,
    generated_node_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS day_map_generation_runs_user_idx
    ON day_map_generation_runs(user_id, generated_at DESC);

COMMIT;
