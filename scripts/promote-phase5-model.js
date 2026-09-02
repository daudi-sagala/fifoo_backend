import { pool } from '../src/db.js';
import { promotePredictionDeployment } from '../src/services/predictionService.js';

const requestedMode = String(process.env.PREDICTION_DEPLOY_MODE ?? 'shadow').toLowerCase();
const rolloutPercent = Math.max(0, Math.min(100, Number(process.env.PREDICTION_ROLLOUT_PERCENT ?? 100)));
const client = await pool.connect();
try {
  await client.query('BEGIN');
  let modelID = process.env.PREDICTION_MODEL_ID ?? null;
  if (!modelID && requestedMode !== 'disabled') {
    const latest = await client.query(
      `SELECT prediction_model_id,model_version,model_status,safety_gate_result
         FROM prediction_models
        WHERE model_name='completion-probability'
        ORDER BY model_version DESC
        LIMIT 1`,
    );
    if (!latest.rowCount) throw new Error('No trained completion model exists. Run npm run train:phase5 first.');
    modelID = latest.rows[0].prediction_model_id;
  }
  if (requestedMode === 'active' && modelID) {
    await client.query(
      `UPDATE prediction_models
          SET model_status='retired',retired_at=NOW()
        WHERE model_name='completion-probability'
          AND model_status='active'
          AND prediction_model_id<>$1`,
      [modelID],
    );
  }
  await promotePredictionDeployment(client, {
    modelID,
    mode: requestedMode,
    rolloutPercent,
    metadata: {
      promotedBy: 'scripts/promote-phase5-model.js',
      promotedAt: new Date().toISOString(),
    },
    minimumShadowLabels: requestedMode === 'active'
      ? Math.max(0, Number(process.env.PHASE5_MIN_SHADOW_LABELS ?? 100))
      : 0,
    requireShadowImprovement: requestedMode === 'active'
      && String(process.env.PHASE5_REQUIRE_SHADOW_IMPROVEMENT ?? 'true').toLowerCase() !== 'false',
  });
  await client.query('COMMIT');
  console.log(JSON.stringify({ success: true, modelID, mode: requestedMode, rolloutPercent }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Phase 5 promotion failed:', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
