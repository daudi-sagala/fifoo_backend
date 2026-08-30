-- Backend Integration Step 3 additions for the existing Fifoo PostgreSQL schema.
-- Apply AFTER the schema that defines users, day_maps, day_map_nodes, day_map_routes,
-- activities, posts, post_replies, workouts, suggested_meals, tasks and join tables.

BEGIN;

CREATE TABLE IF NOT EXISTS day_map_mutations (
    request_id UUID PRIMARY KEY,
    day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    base_revision INTEGER NOT NULL DEFAULT 0 CHECK (base_revision >= 0),
    result_revision INTEGER CHECK (result_revision IS NULL OR result_revision >= 0),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    response JSONB,
    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS day_map_mutations_map_idx ON day_map_mutations(day_map_id, created_at DESC);
CREATE INDEX IF NOT EXISTS day_map_mutations_user_idx ON day_map_mutations(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS day_map_tile_reveals (
    day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    column_index INTEGER NOT NULL,
    row_index INTEGER NOT NULL,
    node_id UUID REFERENCES day_map_nodes(node_id) ON DELETE SET NULL,
    is_revealed BOOLEAN NOT NULL DEFAULT TRUE,
    revealed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(day_map_id,column_index,row_index)
);
CREATE INDEX IF NOT EXISTS day_map_tile_reveals_node_idx ON day_map_tile_reveals(node_id) WHERE node_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS day_map_suggestion_decisions (
    day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    column_index INTEGER NOT NULL,
    row_index INTEGER NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected')),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(day_map_id,user_id,column_index,row_index)
);

CREATE TABLE IF NOT EXISTS post_saves (
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(post_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,post_id)
);
CREATE INDEX IF NOT EXISTS post_saves_post_idx ON post_saves(post_id);

-- The supplied post_replies schema had no dedicated field for the validated
-- GamePostReplyCreatePayload.text value.
ALTER TABLE post_replies ADD COLUMN IF NOT EXISTS reply_text TEXT NOT NULL DEFAULT '';

-- Until a standalone canonical hyperlink table exists, persist votes against the
-- concrete Day Map hyperlink node. The node FK makes deletion cleanup automatic.
CREATE TABLE IF NOT EXISTS day_map_hyperlink_votes (
    day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    node_id UUID NOT NULL REFERENCES day_map_nodes(node_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    vote TEXT NOT NULL CHECK (vote IN ('upvote','downvote')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(day_map_id,node_id,user_id)
);

-- Check-in is distinct from mere activity membership/participation.
CREATE TABLE IF NOT EXISTS activity_check_ins (
    activity_id UUID NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'checked_in',
    checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(activity_id,user_id)
);
CREATE INDEX IF NOT EXISTS activity_check_ins_user_idx ON activity_check_ins(user_id,checked_in_at DESC);

CREATE TABLE IF NOT EXISTS day_map_application_actions (
    action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    action TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS day_map_application_actions_map_idx ON day_map_application_actions(day_map_id,occurred_at DESC);

-- ActivityMeal execution state is richer than the original suggested_meals.meals
-- catalog snapshot. Keep it normalized without losing the exact node snapshot.
ALTER TABLE suggested_meals ADD COLUMN IF NOT EXISTS execution_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- One authoritative serialized route-state record per map.
CREATE UNIQUE INDEX IF NOT EXISTS day_map_routes_state_uq
    ON day_map_routes(day_map_id) WHERE route_type='state';

-- Preserve exact Swift Workout/session snapshots for reconnect restoration.
ALTER TABLE workout_sessions ADD COLUMN IF NOT EXISTS session_data JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE workout_sessions ADD COLUMN IF NOT EXISTS client_workout_id UUID;
CREATE INDEX IF NOT EXISTS workout_sessions_client_workout_idx ON workout_sessions(client_workout_id);
CREATE INDEX IF NOT EXISTS workout_sessions_session_data_gin_idx ON workout_sessions USING GIN(session_data);
CREATE UNIQUE INDEX IF NOT EXISTS workout_sessions_user_client_workout_uq
    ON workout_sessions(created_by,client_workout_id);

CREATE TABLE IF NOT EXISTS workout_session_live_messages (
    workout_session_live_message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workout_session_id UUID NOT NULL REFERENCES workout_sessions(workout_session_id) ON DELETE CASCADE,
    workout_exercise_id UUID,
    message TEXT NOT NULL,
    created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workout_session_live_messages_session_idx
    ON workout_session_live_messages(workout_session_id,created_at);

CREATE TABLE IF NOT EXISTS workout_session_live_reactions (
    workout_session_live_reaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workout_session_id UUID NOT NULL REFERENCES workout_sessions(workout_session_id) ON DELETE CASCADE,
    workout_exercise_id UUID,
    emoji TEXT NOT NULL,
    created_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workout_session_live_reactions_session_idx
    ON workout_session_live_reactions(workout_session_id,created_at);

COMMIT;
