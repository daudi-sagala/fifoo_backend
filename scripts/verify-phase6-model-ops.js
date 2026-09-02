import { pool } from '../src/db.js';

const expectedRelations = [
  'prediction_model_ops_runs',
  'prediction_model_deployment_history',
  'prediction_model_health_snapshots',
  'prediction_model_alerts',
];

const client = await pool.connect();
try {
  const migration = await client.query(
    `SELECT migration_name,applied_at
       FROM fifoo_schema_migrations
      WHERE migration_name LIKE '009%'
      ORDER BY applied_at DESC
      LIMIT 1`,
  );
  if (!migration.rowCount) throw new Error('Phase 6 migration 009 has not been applied.');

  const relations = await client.query(
    `SELECT relname
       FROM pg_class
      WHERE relname=ANY($1::text[])`,
    [expectedRelations],
  );
  const found = new Set(relations.rows.map((row) => row.relname));
  const missing = expectedRelations.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`Missing Phase 6 relations: ${missing.join(', ')}`);

  const deployment = await client.query(
    `SELECT d.deployment_key,d.prediction_model_id,d.fallback_prediction_model_id,
            d.challenger_prediction_model_id,d.deployment_mode,d.rollout_percent,
            d.automation_managed,d.stage_started_at,d.last_health_checked_at,
            m.model_version,m.model_status
       FROM prediction_model_deployments d
       LEFT JOIN prediction_models m ON m.prediction_model_id=d.prediction_model_id
      WHERE d.deployment_key='completion_probability'`,
  );
  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM prediction_models) AS models,
       (SELECT COUNT(*)::int FROM prediction_model_ops_runs) AS ops_runs,
       (SELECT COUNT(*)::int FROM prediction_model_deployment_history) AS deployment_changes,
       (SELECT COUNT(*)::int FROM prediction_model_health_snapshots) AS health_snapshots,
       (SELECT COUNT(*)::int FROM prediction_model_alerts WHERE alert_status='open') AS open_alerts,
       (SELECT COUNT(*)::int FROM learning_completion_examples_v1) AS completion_examples`,
  );
  const recentHealth = await client.query(
    `SELECT prediction_model_id,deployment_mode,rollout_percent,labeled_sample_count,
            health_status,health_reasons,learned_metrics,legacy_metrics,drift_metrics,created_at
       FROM prediction_model_health_snapshots
      ORDER BY created_at DESC
      LIMIT 5`,
  );
  const recentHistory = await client.query(
    `SELECT from_prediction_model_id,to_prediction_model_id,from_mode,to_mode,
            from_rollout_percent,to_rollout_percent,change_reason,automated,occurred_at
       FROM prediction_model_deployment_history
      ORDER BY occurred_at DESC
      LIMIT 10`,
  );

  console.log(JSON.stringify({
    success: true,
    migration: migration.rows[0],
    deployment: deployment.rows?.[0] ?? null,
    counts: counts.rows[0],
    recentHealth: recentHealth.rows,
    recentDeploymentHistory: recentHistory.rows,
    note: 'PREDICTION_RUNTIME_MODE remains the process-level authority cap; database automation cannot exceed it.',
  }, null, 2));
} finally {
  client.release();
  await pool.end();
}
