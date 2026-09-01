-- Future-only Day Graph rerouting.
--
-- Each reroute is a new immutable plan revision linked to its parent. The
-- completed prefix retains its progress budget and the mutable suffix receives
-- only the remaining points. Existing day_map_routes stays the iOS read model.

BEGIN;

ALTER TABLE day_plan_versions
    ADD COLUMN IF NOT EXISTS parent_plan_id UUID
        REFERENCES day_plan_versions(plan_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS reroute_reason TEXT,
    ADD COLUMN IF NOT EXISTS decision_second INTEGER
        CHECK (decision_second IS NULL OR decision_second BETWEEN 1 AND 86399),
    ADD COLUMN IF NOT EXISTS locked_potential_points NUMERIC(10,6) NOT NULL DEFAULT 0
        CHECK (locked_potential_points BETWEEN 0 AND 100);

CREATE INDEX IF NOT EXISTS day_plan_versions_parent_idx
    ON day_plan_versions(parent_plan_id) WHERE parent_plan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS day_plan_interval_lineage (
    lineage_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES day_plan_versions(plan_id) ON DELETE CASCADE,
    new_plan_interval_id UUID NOT NULL REFERENCES day_plan_intervals(plan_interval_id) ON DELETE CASCADE,
    previous_plan_interval_id UUID REFERENCES day_plan_intervals(plan_interval_id) ON DELETE SET NULL,
    lineage_kind TEXT NOT NULL CHECK (lineage_kind IN ('carried','split','replacement')),
    lineage_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_id,new_plan_interval_id)
);

CREATE INDEX IF NOT EXISTS day_plan_interval_lineage_previous_idx
    ON day_plan_interval_lineage(previous_plan_interval_id)
    WHERE previous_plan_interval_id IS NOT NULL;

COMMIT;
