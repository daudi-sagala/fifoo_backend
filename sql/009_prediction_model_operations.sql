-- Phase 6 — automated prediction-model operations / experimentation.
--
-- Adds the automation control plane around Phase 5 models: champion/challenger
-- lineage, immutable deployment history, health/drift snapshots, alerts and
-- lifecycle-run audit records. The process-level PREDICTION_RUNTIME_MODE remains
-- an independent upper-bound safety gate.

BEGIN;

ALTER TABLE prediction_model_deployments
    ADD COLUMN IF NOT EXISTS fallback_prediction_model_id UUID
        REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS challenger_prediction_model_id UUID
        REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS stage_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS automation_managed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS consecutive_healthy_checks INTEGER NOT NULL DEFAULT 0
        CHECK (consecutive_healthy_checks >= 0),
    ADD COLUMN IF NOT EXISTS last_health_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS prediction_model_deployments_challenger_idx
    ON prediction_model_deployments(challenger_prediction_model_id)
    WHERE challenger_prediction_model_id IS NOT NULL;


ALTER TABLE prediction_score_events
    ADD COLUMN IF NOT EXISTS comparator_prediction_model_id UUID
        REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS comparator_probability DOUBLE PRECISION
        CHECK (comparator_probability IS NULL OR comparator_probability BETWEEN 0 AND 1);

CREATE TABLE IF NOT EXISTS prediction_model_ops_runs (
    prediction_model_ops_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_type TEXT NOT NULL,
    operation_status TEXT NOT NULL DEFAULT 'running'
        CHECK (operation_status IN ('running','success','skipped','failed')),
    prediction_model_id UUID REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    trigger_reason TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    deployment_before JSONB NOT NULL DEFAULT '{}'::JSONB,
    deployment_after JSONB NOT NULL DEFAULT '{}'::JSONB,
    metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    error_code TEXT,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS prediction_model_ops_runs_time_idx
    ON prediction_model_ops_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS prediction_model_ops_runs_model_idx
    ON prediction_model_ops_runs(prediction_model_id,started_at DESC);

CREATE TABLE IF NOT EXISTS prediction_model_deployment_history (
    prediction_model_deployment_history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_key TEXT NOT NULL,
    from_prediction_model_id UUID REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    to_prediction_model_id UUID REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    fallback_prediction_model_id UUID REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    challenger_prediction_model_id UUID REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    from_mode TEXT CHECK (from_mode IS NULL OR from_mode IN ('disabled','shadow','active')),
    to_mode TEXT NOT NULL CHECK (to_mode IN ('disabled','shadow','active')),
    from_rollout_percent INTEGER CHECK (from_rollout_percent IS NULL OR from_rollout_percent BETWEEN 0 AND 100),
    to_rollout_percent INTEGER NOT NULL CHECK (to_rollout_percent BETWEEN 0 AND 100),
    change_reason TEXT NOT NULL,
    automated BOOLEAN NOT NULL DEFAULT FALSE,
    decision_metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prediction_model_deployment_history_time_idx
    ON prediction_model_deployment_history(deployment_key,occurred_at DESC);

CREATE TABLE IF NOT EXISTS prediction_model_health_snapshots (
    prediction_model_health_snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_model_id UUID NOT NULL REFERENCES prediction_models(prediction_model_id) ON DELETE CASCADE,
    deployment_mode TEXT NOT NULL CHECK (deployment_mode IN ('shadow','active')),
    rollout_percent INTEGER NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    labeled_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (labeled_sample_count >= 0),
    learned_metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    legacy_metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    comparator_metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    drift_metrics JSONB NOT NULL DEFAULT '{}'::JSONB,
    health_status TEXT NOT NULL
        CHECK (health_status IN ('insufficient','healthy','warning','unhealthy')),
    health_reasons JSONB NOT NULL DEFAULT '[]'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS prediction_model_health_model_time_idx
    ON prediction_model_health_snapshots(prediction_model_id,created_at DESC);

CREATE TABLE IF NOT EXISTS prediction_model_alerts (
    prediction_model_alert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_model_id UUID REFERENCES prediction_models(prediction_model_id) ON DELETE SET NULL,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    alert_status TEXT NOT NULL DEFAULT 'open' CHECK (alert_status IN ('open','resolved')),
    alert_key TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS prediction_model_alerts_open_uq
    ON prediction_model_alerts(alert_key)
    WHERE alert_status='open';


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
    o.observed_at,
    s.comparator_prediction_model_id,
    s.comparator_probability
FROM prediction_score_runs r
JOIN prediction_score_events s
  ON s.prediction_score_run_id=r.prediction_score_run_id
LEFT JOIN latest_outcome o
  ON o.routing_decision_event_id=r.routing_decision_event_id
 AND o.candidate_key=s.candidate_key;

COMMIT;
