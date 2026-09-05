-- Scheduler reminders are transactional with day-plan changes. Never edit older migrations.
BEGIN;
CREATE TABLE notification_preferences (
 user_id UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
 push_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 activity_reminders BOOLEAN NOT NULL DEFAULT TRUE,
 preparation_reminders BOOLEAN NOT NULL DEFAULT TRUE,
 discreet BOOLEAN NOT NULL DEFAULT TRUE,
 sound_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 daily_limit INTEGER NOT NULL DEFAULT 3 CHECK (daily_limit BETWEEN 0 AND 8),
 min_spacing_minutes INTEGER NOT NULL DEFAULT 90 CHECK (min_spacing_minutes BETWEEN 15 AND 720),
 quiet_start_minute INTEGER CHECK (quiet_start_minute BETWEEN 0 AND 1439),
 quiet_end_minute INTEGER CHECK (quiet_end_minute BETWEEN 0 AND 1439),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK ((quiet_start_minute IS NULL) = (quiet_end_minute IS NULL))
);
CREATE TABLE notification_devices (
 registration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
 device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 200),
 token TEXT NOT NULL CHECK (token ~ '^[0-9a-f]{32,512}$'),
 environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
 topic TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 foreground_until TIMESTAMPTZ,
 registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(token,environment,topic),
 UNIQUE(user_id,device_id,environment,topic)
);
CREATE TABLE scheduler_notifications (
 notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
 day_map_id UUID NOT NULL REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
 plan_id UUID NOT NULL REFERENCES day_plan_versions(plan_id) ON DELETE CASCADE,
 plan_revision INTEGER NOT NULL,
 semantic_key TEXT NOT NULL,
 activity_key TEXT,
 source_node_id UUID,
 interval_id UUID,
 kind TEXT NOT NULL CHECK (kind IN ('activity','preparation','schedule_changed')),
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 start_second INTEGER CHECK(start_second BETWEEN 0 AND 86400),
 due_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 explicit_reminder BOOLEAN NOT NULL DEFAULT FALSE,
 status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','published','cancelled','expired')),
 push_state TEXT NOT NULL DEFAULT 'pending' CHECK (push_state IN ('pending','accepted','suppressed','failed')),
 attempt_count INTEGER NOT NULL DEFAULT 0,
 retry_at TIMESTAMPTZ,
 read_at TIMESTAMPTZ,
 published_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,day_map_id,semantic_key)
);
CREATE INDEX scheduler_notifications_due ON scheduler_notifications(due_at) WHERE status='queued';
CREATE INDEX scheduler_notifications_inbox ON scheduler_notifications(user_id,published_at DESC);
CREATE TABLE notification_delivery_attempts (
 attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 notification_id UUID NOT NULL REFERENCES scheduler_notifications(notification_id) ON DELETE CASCADE,
 registration_id UUID REFERENCES notification_devices(registration_id) ON DELETE SET NULL,
 attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 outcome TEXT NOT NULL,
 provider_status INTEGER,
 provider_reason TEXT,
 UNIQUE(notification_id,registration_id,attempted_at)
);
-- This is the first stage of the outbox. It is written by a trigger inside
-- the original plan transaction, including scheduler-initiated reroutes.
CREATE TABLE notification_plan_jobs (
 day_map_id UUID PRIMARY KEY REFERENCES day_maps(day_map_id) ON DELETE CASCADE,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE FUNCTION enqueue_notification_plan() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.plan_status='active' THEN
  INSERT INTO notification_plan_jobs(day_map_id) VALUES(NEW.day_map_id)
  ON CONFLICT(day_map_id) DO UPDATE SET requested_at=NOW();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_plan_committed AFTER INSERT OR UPDATE OF plan_status ON day_plan_versions
 FOR EACH ROW EXECUTE FUNCTION enqueue_notification_plan();
-- A completion/skip can happen without a new day-plan revision. Cancel its
-- reminders in the SAME mutation transaction, not only when a worker polls.
CREATE FUNCTION cancel_activity_notifications() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE affected_node UUID; affected_day UUID; affected_interval UUID;
BEGIN
 IF TG_TABLE_NAME='progress_ledger_entries' THEN
  IF NEW.outcome_status NOT IN ('completed','partiallyCompleted','skipped','superseded','cancelledByConstraint') THEN RETURN NEW; END IF;
  SELECT i.source_node_id,p.day_map_id,i.algorithm_interval_id
   INTO affected_node,affected_day,affected_interval
   FROM day_plan_intervals i JOIN day_plan_versions p USING(plan_id)
   WHERE i.plan_interval_id=NEW.plan_interval_id;
 ELSE
  IF TG_OP='UPDATE' AND NEW.is_enabled THEN RETURN NEW; END IF;
  affected_node := OLD.node_id; affected_day := OLD.day_map_id;
 END IF;
 UPDATE scheduler_notifications SET status='cancelled',push_state='suppressed'
  WHERE day_map_id=affected_day AND kind<>'schedule_changed' AND status IN ('queued','published')
   AND (source_node_id=affected_node OR interval_id=affected_interval);
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_activity_outcome AFTER INSERT ON progress_ledger_entries
 FOR EACH ROW EXECUTE FUNCTION cancel_activity_notifications();
CREATE TRIGGER notification_node_removed BEFORE DELETE OR UPDATE OF is_enabled ON day_map_nodes
 FOR EACH ROW EXECUTE FUNCTION cancel_activity_notifications();
-- Backfill active plans once; the worker is idempotent.
INSERT INTO notification_plan_jobs(day_map_id)
 SELECT DISTINCT day_map_id FROM day_plan_versions WHERE plan_status='active'
 ON CONFLICT DO NOTHING;
COMMIT;
