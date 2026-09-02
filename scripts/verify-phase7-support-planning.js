import { pool } from '../src/db.js';

const expectedRelations = [
  'activity_support_plan_runs',
  'activity_support_edges',
  'user_resource_state',
];

const client = await pool.connect();
try {
  const migration = await client.query(
    `SELECT migration_name,applied_at
       FROM fifoo_schema_migrations
      WHERE migration_name LIKE '010%'
      ORDER BY applied_at DESC
      LIMIT 1`,
  );
  if (!migration.rowCount) throw new Error('Phase 7 MVP migration 010 has not been applied.');

  const relations = await client.query(
    `SELECT relname FROM pg_class WHERE relname=ANY($1::text[])`,
    [expectedRelations],
  );
  const found = new Set(relations.rows.map((row) => row.relname));
  const missing = expectedRelations.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`Missing Phase 7 relations: ${missing.join(', ')}`);

  const counts = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM activity_support_plan_runs) AS plan_runs,
       (SELECT COUNT(*)::int FROM activity_support_edges) AS support_edges,
       (SELECT COUNT(*)::int FROM activity_support_edges WHERE support_status='scheduled') AS scheduled,
       (SELECT COUNT(*)::int FROM activity_support_edges WHERE support_status='blocked') AS blocked,
       (SELECT COUNT(*)::int FROM activity_support_edges WHERE support_status='completed') AS completed,
       (SELECT COUNT(*)::int FROM user_resource_state) AS resource_states`,
  );

  const recent = await client.query(
    `SELECT support_plan_run_id,user_id,anchor_map_date,horizon_hours,run_status,
            target_count,scheduled_count,blocked_count,started_at,finished_at
       FROM activity_support_plan_runs
      ORDER BY started_at DESC
      LIMIT 10`,
  );

  console.log(JSON.stringify({
    success: true,
    migration: migration.rows[0],
    counts: counts.rows[0],
    recentRuns: recent.rows,
    note: 'MVP rules are deterministic; support candidates still pass through the existing completion-prediction/routing pipeline.',
  }, null, 2));
} finally {
  client.release();
  await pool.end();
}
