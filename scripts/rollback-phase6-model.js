import { pool } from '../src/db.js';
import { promotePredictionDeployment } from '../src/services/predictionService.js';

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const current = await client.query(
    `SELECT prediction_model_id,fallback_prediction_model_id,deployment_mode,rollout_percent
       FROM prediction_model_deployments
      WHERE deployment_key='completion_probability'
      FOR UPDATE`,
  );
  const deployment = current.rows?.[0];
  if (!deployment) throw new Error('No completion prediction deployment exists.');

  if (deployment.fallback_prediction_model_id) {
    await promotePredictionDeployment(client, {
      modelID: deployment.fallback_prediction_model_id,
      mode: 'active',
      rolloutPercent: 100,
      automated: false,
      changeReason: 'manual_emergency_rollback_to_fallback',
      metadata: { requestedBy: 'scripts/rollback-phase6-model.js' },
    });
  } else if (deployment.prediction_model_id) {
    await promotePredictionDeployment(client, {
      modelID: deployment.prediction_model_id,
      mode: 'shadow',
      rolloutPercent: 100,
      automated: false,
      changeReason: 'manual_emergency_rollback_to_shadow',
      metadata: { requestedBy: 'scripts/rollback-phase6-model.js' },
    });
  } else {
    await promotePredictionDeployment(client, {
      modelID: null,
      mode: 'disabled',
      rolloutPercent: 0,
      automated: false,
      changeReason: 'manual_emergency_disable',
      metadata: { requestedBy: 'scripts/rollback-phase6-model.js' },
    });
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ success: true, rolledBack: true }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Phase 6 rollback failed:', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
