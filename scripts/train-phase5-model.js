import { pool } from '../src/db.js';
import { trainAndPersistCompletionHierarchy } from '../src/services/modelTraining.js';

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const result = await trainAndPersistCompletionHierarchy(client, {
    dataset: {
      startDate: process.env.PHASE5_TRAIN_START_DATE ?? null,
      endDate: process.env.PHASE5_TRAIN_END_DATE ?? null,
      limit: numberEnv('PHASE5_TRAIN_LIMIT', 1_000_000),
    },
    model: {
      training: {
        logistic: {
          epochs: numberEnv('PHASE5_TRAIN_EPOCHS', 900),
          learningRate: numberEnv('PHASE5_TRAIN_LEARNING_RATE', 0.05),
          l2: numberEnv('PHASE5_TRAIN_L2', 0.002),
        },
      },
      gates: {
        minTestExamples: numberEnv('PHASE5_MIN_TEST_EXAMPLES', 50),
        maxLogLoss: numberEnv('PHASE5_MAX_TEST_LOG_LOSS', 0.75),
        maxBrier: numberEnv('PHASE5_MAX_TEST_BRIER', 0.25),
        maxECE: numberEnv('PHASE5_MAX_TEST_ECE', 0.15),
        minAUC: numberEnv('PHASE5_MIN_TEST_AUC', 0.55),
        requireBaselineImprovement: String(process.env.PHASE5_REQUIRE_BASELINE_IMPROVEMENT ?? 'true').toLowerCase() !== 'false',
      },
      minimumIndividualSamples: numberEnv('PHASE5_MIN_INDIVIDUAL_SAMPLES', 3),
    },
  });
  await client.query('COMMIT');
  console.log(JSON.stringify({ success: true, ...result }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Phase 5 training failed:', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
