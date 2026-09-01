-- Continuous Day Graph + Progress Ledger foundation.
--
-- The existing day_map_nodes/day_map_routes records remain the iOS read model.
-- These tables hold the algorithm's versioned plan, interval coverage, branch
-- structure, immutable outcome history, and learning signals.

BEGIN;

CREATE TABLE IF NOT EXISTS user_routing_profiles (
    user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    profile_version INTEGER NOT NULL DEFAULT 1 CHECK (profile_version > 0),
    onboarding_context JSONB NOT NULL DEFAULT '{}'::JSONB,
    explicit_preferences JSONB NOT NULL DEFAULT '{}'::JSONB,
    behavioral_features JSONB NOT NULL DEFAULT '{}'::JSONB,
    individual_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (individual_sample_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS routing_prediction_priors (
    prior_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name TEXT NOT NULL,
    model_version INTEGER NOT NULL CHECK (model_version > 0),
    prior_level TEXT NOT NULL CHECK (prior_level IN ('population','cohort','individual')),
    subject_user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    feature_signature TEXT NOT NULL DEFAULT 'global',
    candidate_signature TEXT NOT NULL,
    completion_probability NUMERIC(9,8) NOT NULL CHECK (completion_probability BETWEEN 0 AND 1),
    expected_completion_ratio NUMERIC(9,8) CHECK (expected_completion_ratio BETWEEN 0 AND 1),
    sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
    aggregate_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    trained_through TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (prior_level = 'individual' AND subject_user_id IS NOT NULL)
        OR (prior_level <> 'individual' AND subject_user_id IS NULL)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS routing_prediction_priors_identity_uq
    ON routing_prediction_priors(
        model_name,
        model_version,
        prior_level,
        COALESCE(subject_user_id,'00000000-0000-0000-0000-000000000000'::UUID),
        feature_signature,
        candidate_signature
    );
CREATE INDEX IF NOT EXISTS routing_prediction_priors_lookup_idx
    ON routing_prediction_priors(model_name,model_version,prior_level,feature_signature,candidate_signature);

CREATE TABLE IF NOT EXISTS day_plan_versions (
    plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    map_date DATE NOT NULL,
    plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
    plan_status TEXT NOT NULL DEFAULT 'active' CHECK (plan_status IN ('draft','active','superseded','archived')),
    algorithm_name TEXT NOT NULL,
    algorithm_version INTEGER NOT NULL CHECK (algorithm_version > 0),
    rules_hash TEXT NOT NULL,
    total_potential_points NUMERIC(10,6) NOT NULL DEFAULT 100
        CHECK (total_potential_points >= 0 AND total_potential_points <= 100),
    graph_data JSONB NOT NULL,
    routing_context JSONB NOT NULL DEFAULT '{}'::JSONB,
    decision_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    superseded_at TIMESTAMPTZ,
    UNIQUE(day_map_id,plan_revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS day_plan_versions_active_uq
    ON day_plan_versions(day_map_id) WHERE plan_status='active';
CREATE INDEX IF NOT EXISTS day_plan_versions_user_date_idx
    ON day_plan_versions(user_id,map_date DESC,plan_revision DESC);

CREATE TABLE IF NOT EXISTS day_plan_paths (
    plan_path_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES day_plan_versions(plan_id) ON DELETE CASCADE,
    algorithm_path_id UUID NOT NULL,
    path_key TEXT NOT NULL,
    path_kind TEXT NOT NULL CHECK (path_kind IN ('completed','chosen','alternative')),
    path_order INTEGER NOT NULL DEFAULT 0 CHECK (path_order >= 0),
    origin_interval_id UUID,
    rejoin_interval_id UUID,
    route_score NUMERIC,
    expected_progress NUMERIC(10,6) CHECK (expected_progress IS NULL OR expected_progress BETWEEN 0 AND 100),
    path_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_id,algorithm_path_id),
    UNIQUE(plan_id,path_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS day_plan_paths_chosen_uq
    ON day_plan_paths(plan_id) WHERE path_kind='chosen';

CREATE TABLE IF NOT EXISTS day_plan_intervals (
    plan_interval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES day_plan_versions(plan_id) ON DELETE CASCADE,
    plan_path_id UUID NOT NULL REFERENCES day_plan_paths(plan_path_id) ON DELETE CASCADE,
    algorithm_interval_id UUID NOT NULL,
    source_node_id UUID REFERENCES day_map_nodes(node_id) ON DELETE SET NULL,
    interval_key TEXT NOT NULL,
    interval_kind TEXT NOT NULL CHECK (
        interval_kind IN ('meal','workout','task','sleep','fasting','recovery','movement','travel','freeTime')
    ),
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
    start_second INTEGER NOT NULL CHECK (start_second BETWEEN 0 AND 86399),
    end_second INTEGER NOT NULL CHECK (end_second BETWEEN 1 AND 86400),
    progress_category TEXT NOT NULL,
    potential_points NUMERIC(10,6) NOT NULL DEFAULT 0 CHECK (potential_points BETWEEN 0 AND 100),
    planned_progress_start NUMERIC(10,6) NOT NULL DEFAULT 0 CHECK (planned_progress_start BETWEEN 0 AND 100),
    planned_progress_end NUMERIC(10,6) NOT NULL DEFAULT 0 CHECK (planned_progress_end BETWEEN 0 AND 100),
    lifecycle_status TEXT NOT NULL DEFAULT 'planned' CHECK (
        lifecycle_status IN (
            'planned','active','completed','partiallyCompleted','skipped',
            'superseded','cancelledByConstraint'
        )
    ),
    completion_evaluator JSONB NOT NULL DEFAULT '{"type":"binary"}'::JSONB,
    metabolic_context TEXT,
    interval_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_second > start_second),
    CHECK (planned_progress_end >= planned_progress_start),
    UNIQUE(plan_id,algorithm_interval_id),
    UNIQUE(plan_path_id,sequence_number)
);
CREATE INDEX IF NOT EXISTS day_plan_intervals_plan_time_idx
    ON day_plan_intervals(plan_id,start_second,end_second);
CREATE INDEX IF NOT EXISTS day_plan_intervals_source_node_idx
    ON day_plan_intervals(source_node_id) WHERE source_node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS progress_ledger_entries (
    ledger_entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES day_plan_versions(plan_id) ON DELETE CASCADE,
    plan_interval_id UUID NOT NULL REFERENCES day_plan_intervals(plan_interval_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    potential_points NUMERIC(10,6) NOT NULL CHECK (potential_points BETWEEN 0 AND 100),
    completion_score NUMERIC(9,8) NOT NULL CHECK (completion_score BETWEEN 0 AND 1),
    earned_points NUMERIC(10,6) NOT NULL CHECK (earned_points BETWEEN 0 AND 100),
    outcome_status TEXT NOT NULL CHECK (
        outcome_status IN ('completed','partiallyCompleted','skipped','superseded','cancelledByConstraint')
    ),
    reason_code TEXT,
    evidence JSONB NOT NULL DEFAULT '{}'::JSONB,
    observed_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    supersedes_entry_id UUID REFERENCES progress_ledger_entries(ledger_entry_id) ON DELETE SET NULL,
    CHECK (earned_points <= potential_points)
);
CREATE INDEX IF NOT EXISTS progress_ledger_interval_idx
    ON progress_ledger_entries(plan_interval_id,recorded_at DESC);
CREATE INDEX IF NOT EXISTS progress_ledger_user_idx
    ON progress_ledger_entries(user_id,observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS progress_ledger_supersedes_uq
    ON progress_ledger_entries(supersedes_entry_id) WHERE supersedes_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS routing_decision_events (
    routing_decision_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID REFERENCES day_plan_versions(plan_id) ON DELETE CASCADE,
    day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    decision_type TEXT NOT NULL,
    candidate_key TEXT,
    candidate_data JSONB NOT NULL DEFAULT '{}'::JSONB,
    predicted_completion_probability NUMERIC(9,8)
        CHECK (predicted_completion_probability IS NULL OR predicted_completion_probability BETWEEN 0 AND 1),
    predicted_progress NUMERIC(10,6)
        CHECK (predicted_progress IS NULL OR predicted_progress BETWEEN 0 AND 100),
    route_score NUMERIC,
    was_selected BOOLEAN,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS routing_decision_events_learning_idx
    ON routing_decision_events(user_id,occurred_at DESC,decision_type);

-- Reject temporal gaps/overlaps inside an individual path. Cross-path overlap
-- is valid because alternatives represent mutually exclusive futures.
CREATE OR REPLACE FUNCTION fifoo_validate_day_plan_interval()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM day_plan_intervals existing
         WHERE existing.plan_path_id = NEW.plan_path_id
           AND existing.plan_interval_id <> NEW.plan_interval_id
           AND int4range(existing.start_second,existing.end_second,'[)')
               && int4range(NEW.start_second,NEW.end_second,'[)')
    ) THEN
        RAISE EXCEPTION 'day plan intervals may not overlap within one path';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS day_plan_intervals_no_overlap ON day_plan_intervals;
CREATE TRIGGER day_plan_intervals_no_overlap
BEFORE INSERT OR UPDATE OF plan_path_id,start_second,end_second
ON day_plan_intervals
FOR EACH ROW EXECUTE FUNCTION fifoo_validate_day_plan_interval();

COMMIT;
