import { pool } from '../src/db.js';
import { predictionMetrics } from '../src/ml/completionModel.js';

const expectedRelations = [
  'prediction_models',
  'prediction_model_cohorts',
  'prediction_model_users',
  'prediction_model_deployments',
  'prediction_score_runs',
  'prediction_score_events',
  'prediction_shadow_evaluation_v1',
];

const client = await pool.connect();
try {
  const migration = await client.query(
    `SELECT version,name,applied_at
       FROM fifoo_schema_migrations
      WHERE version='008'
      LIMIT 1`,
  );
  const relations = await client.query(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])`,
    [expectedRelations],
  );
  const present = new Set(relations.rows.map((row) => row.relname));
  const missing = expectedRelations.filter((name) => !present.has(name));
  if (!migration.rowCount || missing.length) {
    throw new Error(`Phase 5 schema incomplete. Missing: ${missing.join(', ') || 'migration 008'}`);
  }

  const deployment = await client.query(
    `SELECT d.deployment_key,d.deployment_mode,d.rollout_percent,d.updated_at,
            m.prediction_model_id,m.model_version,m.model_status,m.training_metrics,
            m.baseline_metrics,m.safety_gate_result,m.test_example_count
       FROM prediction_model_deployments d
       LEFT JOIN prediction_models m ON m.prediction_model_id=d.prediction_model_id
      WHERE d.deployment_key='completion_probability'`,
  );
  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM prediction_models) AS models,
       (SELECT COUNT(*)::int FROM prediction_model_cohorts) AS cohorts,
       (SELECT COUNT(*)::int FROM prediction_model_users) AS personalized_users,
       (SELECT COUNT(*)::int FROM prediction_score_runs) AS score_runs,
       (SELECT COUNT(*)::int FROM prediction_score_events) AS score_events`,
  );
  const shadowRows = await client.query(
    `SELECT legacy_probability,final_probability,actual_status
       FROM prediction_shadow_evaluation_v1
      WHERE actual_status IS NOT NULL
      ORDER BY observed_at DESC
      LIMIT 10000`,
  );
  const labels = shadowRows.rows.map((row) => String(row.actual_status).toLowerCase() === 'completed' ? 1 : 0);
  const legacy = shadowRows.rows.map((row) => Number(row.legacy_probability));
  const learned = shadowRows.rows.map((row) => Number(row.final_probability));

  console.log(JSON.stringify({
    success: true,
    migration: migration.rows[0],
    deployment: deployment.rows[0] ?? null,
    counts: counts.rows[0],
    shadowEvaluation: {
      labeledExamples: labels.length,
      legacy: predictionMetrics(legacy, labels),
      learned: predictionMetrics(learned, labels),
    },
  }, null, 2));
} finally {
  client.release();
  await pool.end();
}
