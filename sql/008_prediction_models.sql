-- Phase 5 — cohort/personalized completion prediction models.
--
-- Stores versioned offline-trained population models, cohort and individual
-- calibration layers, explicit deployment gates, and immutable shadow/active
-- score traces. The deterministic routing engine remains the hard-constraint
-- authority; predictions only influence completion probability / route ranking.

BEGIN;

CREATE TABLE IF NOT EXISTS prediction_models (
    prediction_model_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name TEXT NOT NULL,
    model_family TEXT NOT NULL,
    model_version INTEGER NOT NULL CHECK (model_version > 0),
    model_status TEXT NOT NULL DEFAULT 'draft'
        CHECK (model_status IN ('draft','shadow','active','rejected','retired')),
    training_view TEXT NOT NULL,
    feature_schema_version INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    model_artifact JSONB NOT NULL,
    calibration_artifact JSONB NOT NULL DEFAULT '{}'::JSONB,
    training_metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    baseline_metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    safety_gate_result JSONB NOT NULL DEFAULT '{}'::JSONB,
    train_window_start TIMESTAMPTZ,
    train_window_end TIMESTAMPTZ,
    validation_window_start TIMESTAMPTZ,
    validation_window_end TIMESTAMPTZ,
    test_window_start TIMESTAMPTZ,
    test_window_end TIMESTAMPTZ,
    train_example_count INTEGER NOT NULL DEFAULT 0,
    validation_example_count INTEGER NOT NULL DEFAULT 0,
    test_example_count INTEGER NOT NULL DEFAULT 0,
    trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(model_name,model_version)
);

CREATE INDEX IF NOT EXISTS prediction_models_status_idx
    ON prediction_models(model_name,model_status,model_version DESC);

CREATE TABLE IF NOT EXISTS prediction_model_cohorts (
    prediction_model_cohort_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_model_id UUID NOT NULL REFERENCES prediction_models(prediction_model_id) ON DELETE CASCADE,
    cohort_key TEXT NOT NULL,
    cohort_dimensions JSONB NOT NULL DEFAULT '{}'::JSONB,
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    positive_count INTEGER NOT NULL CHECK (positive_count >= 0),
    raw_completion_rate DOUBLE PRECISION,
    mean_population_prediction DOUBLE PRECISION,
    raw_logit_offset DOUBLE PRECISION NOT NULL DEFAULT 0,
    logit_offset DOUBLE PRECISION NOT NULL DEFAULT 0,
    shrinkage_weight DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (shrinkage_weight BETWEEN 0 AND 1),
    metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(prediction_model_id,cohort_key)
);

CREATE INDEX IF NOT EXISTS prediction_model_cohorts_lookup_idx
    ON prediction_model_cohorts(prediction_model_id,cohort_key);

CREATE TABLE IF NOT EXISTS prediction_model_users (
    prediction_model_user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_model_id UUID NOT NULL REFERENCES prediction_models(prediction_model_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    positive_count INTEGER NOT NULL CHECK (positive_count >= 0),
    raw_completion_rate DOUBLE PRECISION,
    mean_population_prediction DOUBLE PRECISION,
    raw_logit_offset DOUBLE PRECISION NOT NULL DEFAULT 0,
    logit_offset DOUBLE PRECISION NOT NULL DEFAULT 0,
    shrinkage_weight DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (shrinkage_weight BETWEEN 0 AND 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(prediction_model_id,user_id)
);

CREATE INDEX IF NOT EXISTS prediction_model_users_lookup_idx
    ON prediction_model_users(prediction_model_id,user_id);

CREATE TABLE IF NOT EXISTS prediction_model_deployments (
    deployment_key TEXT PRIMARY KEY,
    prediction_model_id UUID REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    deployment_mode TEXT NOT NULL DEFAULT 'disabled'
        CHECK (deployment_mode IN ('disabled','shadow','active')),
    rollout_percent INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
    deployment_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO prediction_model_deployments(deployment_key,deployment_mode,rollout_percent)
VALUES ('completion_probability','disabled',100)
ON CONFLICT(deployment_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS prediction_score_runs (
    prediction_score_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_model_id UUID REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    routing_decision_event_id UUID REFERENCES routing_decision_events(routing_decision_event_id) ON DELETE SET NULL,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    day_map_id UUID REFERENCES day_maps(day_map_id) ON DELETE SET NULL,
    map_date DATE,
    request_id UUID,
    configured_mode TEXT NOT NULL CHECK (configured_mode IN ('shadow','active')),
    effective_mode TEXT NOT NULL CHECK (effective_mode IN ('shadow','active')),
    model_name TEXT NOT NULL,
    model_version INTEGER NOT NULL,
    scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    context_data JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS prediction_score_runs_decision_idx
    ON prediction_score_runs(routing_decision_event_id);
CREATE INDEX IF NOT EXISTS prediction_score_runs_user_time_idx
    ON prediction_score_runs(user_id,scored_at DESC);

CREATE TABLE IF NOT EXISTS prediction_score_events (
    prediction_score_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_score_run_id UUID NOT NULL REFERENCES prediction_score_runs(prediction_score_run_id) ON DELETE CASCADE,
    candidate_key TEXT NOT NULL,
    source_node_id UUID,
    candidate_kind TEXT,
    cohort_key TEXT,
    population_probability DOUBLE PRECISION NOT NULL CHECK (population_probability BETWEEN 0 AND 1),
    cohort_probability DOUBLE PRECISION NOT NULL CHECK (cohort_probability BETWEEN 0 AND 1),
    personalized_probability DOUBLE PRECISION NOT NULL CHECK (personalized_probability BETWEEN 0 AND 1),
    final_probability DOUBLE PRECISION NOT NULL CHECK (final_probability BETWEEN 0 AND 1),
    legacy_probability DOUBLE PRECISION NOT NULL CHECK (legacy_probability BETWEEN 0 AND 1),
    applied_probability DOUBLE PRECISION NOT NULL CHECK (applied_probability BETWEEN 0 AND 1),
    prediction_level TEXT NOT NULL CHECK (prediction_level IN ('population','cohort','personalized')),
    cohort_sample_count INTEGER NOT NULL DEFAULT 0,
    individual_sample_count INTEGER NOT NULL DEFAULT 0,
    score_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(prediction_score_run_id,candidate_key)
);

CREATE INDEX IF NOT EXISTS prediction_score_events_run_idx
    ON prediction_score_events(prediction_score_run_id);

CREATE OR REPLACE VIEW prediction_shadow_evaluation_v1 AS
WITH latest_outcome AS (
    SELECT DISTINCT ON (o.routing_decision_event_id,o.candidate_key)
        o.*
    FROM learning_outcome_observations o
    WHERE o.routing_decision_event_id IS NOT NULL
      AND o.candidate_key IS NOT NULL
    ORDER BY
        o.routing_decision_event_id,
        o.candidate_key,
        o.observed_at DESC,
        o.recorded_at DESC,
        o.learning_outcome_observation_id DESC
)
SELECT
    r.prediction_score_run_id,
    r.prediction_model_id,
    r.model_name,
    r.model_version,
    r.effective_mode,
    r.scored_at,
    r.user_id,
    r.map_date,
    s.candidate_key,
    s.candidate_kind,
    s.cohort_key,
    s.population_probability,
    s.cohort_probability,
    s.personalized_probability,
    s.final_probability,
    s.legacy_probability,
    s.applied_probability,
    s.prediction_level,
    o.actual_status,
    o.completion_score,
    o.earned_points,
    o.potential_points,
    o.observed_at
FROM prediction_score_runs r
JOIN prediction_score_events s
  ON s.prediction_score_run_id=r.prediction_score_run_id
LEFT JOIN latest_outcome o
  ON o.routing_decision_event_id=r.routing_decision_event_id
 AND o.candidate_key=s.candidate_key;

COMMIT;
