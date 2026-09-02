-- Phase 4 — learning-data foundation.
--
-- Extends the Phase 3 immutable Day Graph/progress ledger with point-in-time
-- decision context, candidate/route exposures, actual outcomes and reproducible
-- training views. No prediction model is trained in this migration.

BEGIN;

ALTER TABLE routing_decision_events
    ADD COLUMN IF NOT EXISTS parent_plan_id UUID
        REFERENCES day_plan_versions(plan_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS plan_revision INTEGER,
    ADD COLUMN IF NOT EXISTS map_date DATE,
    ADD COLUMN IF NOT EXISTS time_zone_identifier TEXT,
    ADD COLUMN IF NOT EXISTS decision_second INTEGER
        CHECK (decision_second IS NULL OR decision_second BETWEEN 0 AND 86400),
    ADD COLUMN IF NOT EXISTS reroute_reason TEXT,
    ADD COLUMN IF NOT EXISTS algorithm_name TEXT,
    ADD COLUMN IF NOT EXISTS algorithm_version INTEGER,
    ADD COLUMN IF NOT EXISTS rules_hash TEXT,
    ADD COLUMN IF NOT EXISTS prediction_mode TEXT,
    ADD COLUMN IF NOT EXISTS prediction_model_name TEXT,
    ADD COLUMN IF NOT EXISTS prediction_model_version INTEGER,
    ADD COLUMN IF NOT EXISTS feature_schema_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'phase4-v1',
    ADD COLUMN IF NOT EXISTS request_id UUID,
    ADD COLUMN IF NOT EXISTS selected_route_key TEXT,
    ADD COLUMN IF NOT EXISTS context_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    ADD COLUMN IF NOT EXISTS progress_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS routing_decision_events_request_uq
    ON routing_decision_events(request_id)
    WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS routing_decision_events_plan_idx
    ON routing_decision_events(plan_id,occurred_at DESC);

CREATE INDEX IF NOT EXISTS routing_decision_events_date_idx
    ON routing_decision_events(map_date,user_id,occurred_at DESC);

CREATE TABLE IF NOT EXISTS learning_decision_candidates (
    learning_decision_candidate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    routing_decision_event_id UUID NOT NULL
        REFERENCES routing_decision_events(routing_decision_event_id) ON DELETE CASCADE,
    candidate_key TEXT NOT NULL,
    decision_group TEXT,
    candidate_kind TEXT,
    source_node_id UUID REFERENCES day_map_nodes(node_id) ON DELETE SET NULL,
    candidate_rank INTEGER CHECK (candidate_rank IS NULL OR candidate_rank >= 0),
    was_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    was_selected BOOLEAN NOT NULL DEFAULT FALSE,
    exclusion_reason TEXT,
    predicted_completion_probability NUMERIC(9,8)
        CHECK (
            predicted_completion_probability IS NULL
            OR predicted_completion_probability BETWEEN 0 AND 1
        ),
    predicted_progress_points NUMERIC(10,6)
        CHECK (
            predicted_progress_points IS NULL
            OR predicted_progress_points BETWEEN 0 AND 100
        ),
    candidate_features JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(routing_decision_event_id,candidate_key)
);

CREATE INDEX IF NOT EXISTS learning_decision_candidates_node_idx
    ON learning_decision_candidates(source_node_id)
    WHERE source_node_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS learning_decision_candidates_selected_idx
    ON learning_decision_candidates(routing_decision_event_id,was_selected,candidate_rank);

CREATE TABLE IF NOT EXISTS learning_decision_routes (
    learning_decision_route_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    routing_decision_event_id UUID NOT NULL
        REFERENCES routing_decision_events(routing_decision_event_id) ON DELETE CASCADE,
    route_key TEXT NOT NULL,
    route_kind TEXT NOT NULL CHECK (route_kind IN ('chosen','alternative','candidate')),
    route_rank INTEGER NOT NULL DEFAULT 0 CHECK (route_rank >= 0),
    was_selected BOOLEAN NOT NULL DEFAULT FALSE,
    route_score NUMERIC,
    expected_progress NUMERIC(10,6)
        CHECK (expected_progress IS NULL OR expected_progress BETWEEN 0 AND 100),
    selected_candidate_keys TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    route_features JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(routing_decision_event_id,route_key)
);

CREATE INDEX IF NOT EXISTS learning_decision_routes_rank_idx
    ON learning_decision_routes(routing_decision_event_id,route_rank);

CREATE TABLE IF NOT EXISTS learning_feature_snapshots (
    learning_feature_snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    routing_decision_event_id UUID NOT NULL UNIQUE
        REFERENCES routing_decision_events(routing_decision_event_id) ON DELETE CASCADE,
    as_of TIMESTAMPTZ NOT NULL,
    feature_schema_version INTEGER NOT NULL CHECK (feature_schema_version > 0),
    sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
    source_window_start TIMESTAMPTZ,
    source_window_end TIMESTAMPTZ,
    feature_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS learning_feature_snapshots_user_idx
    ON learning_feature_snapshots(user_id,as_of DESC);

CREATE TABLE IF NOT EXISTS learning_outcome_observations (
    learning_outcome_observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ledger_entry_id UUID NOT NULL UNIQUE
        REFERENCES progress_ledger_entries(ledger_entry_id) ON DELETE CASCADE,
    supersedes_learning_outcome_id UUID
        REFERENCES learning_outcome_observations(learning_outcome_observation_id) ON DELETE SET NULL,
    routing_decision_event_id UUID
        REFERENCES routing_decision_events(routing_decision_event_id) ON DELETE SET NULL,
    learning_decision_candidate_id UUID
        REFERENCES learning_decision_candidates(learning_decision_candidate_id) ON DELETE SET NULL,
    plan_id UUID NOT NULL REFERENCES day_plan_versions(plan_id) ON DELETE CASCADE,
    plan_interval_id UUID NOT NULL REFERENCES day_plan_intervals(plan_interval_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    source_node_id UUID REFERENCES day_map_nodes(node_id) ON DELETE SET NULL,
    candidate_key TEXT,
    interval_kind TEXT NOT NULL,
    scheduled_start_second INTEGER NOT NULL CHECK (scheduled_start_second BETWEEN 0 AND 86399),
    scheduled_end_second INTEGER NOT NULL CHECK (scheduled_end_second BETWEEN 1 AND 86400),
    actual_status TEXT NOT NULL CHECK (
        actual_status IN ('completed','partiallyCompleted','skipped','superseded','cancelledByConstraint')
    ),
    completion_score NUMERIC(9,8) NOT NULL CHECK (completion_score BETWEEN 0 AND 1),
    potential_points NUMERIC(10,6) NOT NULL CHECK (potential_points BETWEEN 0 AND 100),
    earned_points NUMERIC(10,6) NOT NULL CHECK (earned_points BETWEEN 0 AND 100),
    reason_code TEXT,
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
    observed_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (scheduled_end_second > scheduled_start_second),
    CHECK (earned_points <= potential_points)
);

CREATE INDEX IF NOT EXISTS learning_outcome_observations_user_idx
    ON learning_outcome_observations(user_id,observed_at DESC);

CREATE INDEX IF NOT EXISTS learning_outcome_observations_decision_idx
    ON learning_outcome_observations(routing_decision_event_id,observed_at DESC)
    WHERE routing_decision_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS learning_outcome_observations_candidate_idx
    ON learning_outcome_observations(learning_decision_candidate_id,observed_at DESC)
    WHERE learning_decision_candidate_id IS NOT NULL;

-- One row per candidate exposure. This is the route/candidate-choice substrate.
CREATE OR REPLACE VIEW learning_candidate_choice_examples_v1 AS
SELECT
    e.routing_decision_event_id,
    e.user_id,
    e.map_date,
    e.occurred_at AS decision_at,
    e.time_zone_identifier,
    e.decision_second,
    e.decision_type,
    e.reroute_reason,
    e.algorithm_name,
    e.algorithm_version,
    e.rules_hash,
    e.prediction_mode,
    e.prediction_model_name,
    e.prediction_model_version,
    e.feature_schema_version,
    e.policy_version,
    e.context_data,
    e.progress_snapshot,
    c.learning_decision_candidate_id,
    c.candidate_key,
    c.decision_group,
    c.candidate_kind,
    c.source_node_id,
    c.candidate_rank,
    c.was_eligible,
    c.was_selected,
    c.predicted_completion_probability,
    c.predicted_progress_points,
    c.candidate_features
FROM routing_decision_events e
JOIN learning_decision_candidates c
  ON c.routing_decision_event_id=e.routing_decision_event_id;

-- Only exposed/selected activities with observed outcomes belong in a completion
-- target set. Corrections remain append-only; the latest observation is selected.
CREATE OR REPLACE VIEW learning_completion_examples_v1 AS
WITH latest_outcome AS (
    SELECT DISTINCT ON (o.learning_decision_candidate_id)
        o.*
    FROM learning_outcome_observations o
    WHERE o.learning_decision_candidate_id IS NOT NULL
    ORDER BY
        o.learning_decision_candidate_id,
        o.observed_at DESC,
        o.recorded_at DESC,
        o.learning_outcome_observation_id DESC
)
SELECT
    e.routing_decision_event_id,
    e.user_id,
    e.map_date,
    e.occurred_at AS decision_at,
    e.time_zone_identifier,
    e.decision_second,
    e.decision_type,
    e.reroute_reason,
    e.algorithm_name,
    e.algorithm_version,
    e.rules_hash,
    e.prediction_mode,
    e.prediction_model_name,
    e.prediction_model_version,
    e.feature_schema_version,
    e.policy_version,
    e.context_data,
    e.progress_snapshot,
    c.learning_decision_candidate_id,
    c.candidate_key,
    c.decision_group,
    c.candidate_kind,
    c.source_node_id,
    c.candidate_rank,
    c.predicted_completion_probability,
    c.predicted_progress_points,
    c.candidate_features,
    o.actual_status,
    o.completion_score,
    o.potential_points,
    o.earned_points,
    o.reason_code,
    o.observed_at,
    o.evidence
FROM routing_decision_events e
JOIN learning_decision_candidates c
  ON c.routing_decision_event_id=e.routing_decision_event_id
JOIN latest_outcome o
  ON o.learning_decision_candidate_id=c.learning_decision_candidate_id
WHERE c.was_selected=TRUE;

CREATE OR REPLACE VIEW learning_route_choice_examples_v1 AS
SELECT
    e.routing_decision_event_id,
    e.user_id,
    e.map_date,
    e.occurred_at AS decision_at,
    e.time_zone_identifier,
    e.decision_second,
    e.decision_type,
    e.reroute_reason,
    e.algorithm_name,
    e.algorithm_version,
    e.rules_hash,
    e.prediction_mode,
    e.prediction_model_name,
    e.prediction_model_version,
    e.feature_schema_version,
    e.policy_version,
    e.context_data,
    e.progress_snapshot,
    r.learning_decision_route_id,
    r.route_key,
    r.route_kind,
    r.route_rank,
    r.was_selected,
    r.route_score,
    r.expected_progress,
    r.selected_candidate_keys,
    r.route_features
FROM routing_decision_events e
JOIN learning_decision_routes r
  ON r.routing_decision_event_id=e.routing_decision_event_id;

COMMIT;
