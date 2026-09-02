-- Phase 7 MVP — future activity support planning.
--
-- Adds a semantic support graph beside the existing spatial/Day Graph. Support
-- actions are still ordinary Day Map nodes; these rows preserve why they exist,
-- their target, scheduling outcome, and prediction-ready evidence.

BEGIN;

CREATE TABLE IF NOT EXISTS activity_support_plan_runs (
    support_plan_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    anchor_map_date DATE NOT NULL,
    horizon_hours INTEGER NOT NULL CHECK (horizon_hours BETWEEN 1 AND 336),
    run_status TEXT NOT NULL DEFAULT 'running'
        CHECK (run_status IN ('running','success','partial','failed')),
    target_count INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
    scheduled_count INTEGER NOT NULL DEFAULT 0 CHECK (scheduled_count >= 0),
    blocked_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS activity_support_plan_runs_user_started_idx
    ON activity_support_plan_runs(user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS activity_support_edges (
    support_edge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    target_day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    target_node_id UUID NOT NULL REFERENCES day_map_nodes(node_id) ON DELETE CASCADE,
    support_day_map_id UUID REFERENCES day_maps(day_map_id) ON DELETE SET NULL,
    support_node_id UUID REFERENCES day_map_nodes(node_id) ON DELETE SET NULL,
    rule_key TEXT NOT NULL,
    relationship_type TEXT NOT NULL
        CHECK (relationship_type IN ('requires','prepares_for','resource_for','reduces_risk')),
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1
        CHECK (confidence BETWEEN 0 AND 1),
    required_by TIMESTAMPTZ,
    support_status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (support_status IN ('scheduled','completed','dismissed','blocked','superseded')),
    support_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id,target_node_id,rule_key)
);

CREATE INDEX IF NOT EXISTS activity_support_edges_user_status_idx
    ON activity_support_edges(user_id, support_status, required_by);
CREATE INDEX IF NOT EXISTS activity_support_edges_target_idx
    ON activity_support_edges(target_node_id);
CREATE INDEX IF NOT EXISTS activity_support_edges_support_idx
    ON activity_support_edges(support_node_id)
    WHERE support_node_id IS NOT NULL;

-- Optional resource-state boundary for later rules/integrations. The MVP does
-- not guess that an unknown resource is absent; callers must explicitly mark a
-- resource unavailable before a future rule depends on it.
CREATE TABLE IF NOT EXISTS user_resource_state (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    resource_key TEXT NOT NULL,
    resource_state TEXT NOT NULL
        CHECK (resource_state IN ('available','unavailable','unknown')),
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1
        CHECK (confidence BETWEEN 0 AND 1),
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    source TEXT NOT NULL DEFAULT 'user',
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,resource_key)
);

COMMIT;
