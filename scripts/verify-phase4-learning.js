import { pool } from '../src/db.js';

const expectedRelations = [
  'routing_decision_events',
  'learning_decision_candidates',
  'learning_decision_routes',
  'learning_feature_snapshots',
  'learning_outcome_observations',
  'learning_candidate_choice_examples_v1',
  'learning_completion_examples_v1',
  'learning_route_choice_examples_v1',
];

const client = await pool.connect();
try {
  const relations = await client.query(
    `SELECT name,to_regclass(name) AS relation
       FROM unnest($1::text[]) AS names(name)`,
    [expectedRelations],
  );
  const missing = relations.rows.filter((row) => row.relation == null).map((row) => row.name);
  if (missing.length) throw new Error(`Missing Phase 4 database relations: ${missing.join(', ')}`);

  const migration = await client.query(
    `SELECT filename,applied_at
       FROM fifoo_schema_migrations
      WHERE filename='007_learning_data_foundation.sql'`,
  );
  if (!migration.rowCount) throw new Error('Migration 007_learning_data_foundation.sql has not been applied.');

  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM routing_decision_events) AS decisions,
       (SELECT COUNT(*)::int FROM learning_decision_candidates) AS candidates,
       (SELECT COUNT(*)::int FROM learning_decision_routes) AS routes,
       (SELECT COUNT(*)::int FROM learning_feature_snapshots) AS feature_snapshots,
       (SELECT COUNT(*)::int FROM learning_outcome_observations) AS outcomes,
       (SELECT COUNT(*)::int FROM learning_completion_examples_v1) AS completion_examples`,
  );

  const quality = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE e.feature_schema_version IS NULL)::int AS decisions_missing_feature_version,
       COUNT(*) FILTER (WHERE e.rules_hash IS NULL)::int AS decisions_missing_rules_hash,
       COUNT(*) FILTER (WHERE e.plan_id IS NOT NULL AND fs.routing_decision_event_id IS NULL)::int AS decisions_missing_feature_snapshot
     FROM routing_decision_events e
     LEFT JOIN learning_feature_snapshots fs
       ON fs.routing_decision_event_id=e.routing_decision_event_id`,
  );

  const orphanedOutcomes = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM learning_outcome_observations o
      WHERE o.routing_decision_event_id IS NULL OR o.learning_decision_candidate_id IS NULL`,
  );

  console.log(JSON.stringify({
    success: true,
    migration: migration.rows[0],
    counts: counts.rows[0],
    quality: quality.rows[0],
    outcomeLinkage: {
      orphaned: Number(orphanedOutcomes.rows[0]?.count ?? 0),
      note: 'An orphan can be valid for historical Phase 3 outcomes created before Phase 4 capture existed.',
    },
  }, null, 2));
} finally {
  client.release();
  await pool.end();
}
