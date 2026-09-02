import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { pool } from '../db.js';
import { logger } from '../lib/logger.js';
import { runPredictionModelLifecycle } from './modelOps.js';

let startupHandle = null;
let intervalHandle = null;
let running = false;

function lifecycleConfig() {
  return {
    enabled: config.predictionModelOpsEnabled,
    runtimeMode: config.predictionRuntimeMode,
    trainingLimit: config.predictionModelOpsTrainingLimit,
    trainingEpochs: config.predictionModelOpsTrainingEpochs,
    evaluationLimit: config.predictionModelOpsEvaluationLimit,
    minimumTrainingExamples: config.predictionModelOpsMinimumTrainingExamples,
    retrainMinimumNewLabels: config.predictionModelOpsRetrainMinimumNewLabels,
    retrainMinimumIntervalHours: config.predictionModelOpsRetrainMinimumIntervalHours,
    retrainMaximumIntervalHours: config.predictionModelOpsRetrainMaximumIntervalHours,
    minimumHealthyChecks: config.predictionModelOpsMinimumHealthyChecks,
    minimumIndividualSamples: config.predictionModelOpsMinimumIndividualSamples,
    minimumShadowLabels: config.predictionModelOpsMinimumShadowLabels,
    minimumCanaryLabels: config.predictionModelOpsMinimumCanaryLabels,
    minimumShadowLogLossImprovement: config.predictionModelOpsMinimumShadowLogLossImprovement,
    rolloutSteps: config.predictionModelOpsRolloutSteps,
    automaticRollback: config.predictionModelOpsAutomaticRollback,
    offlineGates: {
      minTestExamples: config.predictionModelOpsOfflineMinTestExamples,
      maxLogLoss: config.predictionModelOpsOfflineMaxLogLoss,
      maxBrier: config.predictionModelOpsOfflineMaxBrier,
      maxECE: config.predictionModelOpsOfflineMaxECE,
      minAUC: config.predictionModelOpsOfflineMinAUC,
      requireBaselineImprovement: true,
    },
    healthGates: {
      maxLogLossRegression: config.predictionModelOpsMaxLogLossRegression,
      maxBrierRegression: config.predictionModelOpsMaxBrierRegression,
      maxECE: config.predictionModelOpsMaxECE,
      maxPSI: config.predictionModelOpsMaxPSI,
      maxPositiveRateDelta: config.predictionModelOpsMaxPositiveRateDelta,
      minimumCohortLabels: config.predictionModelOpsMinimumCohortLabels,
      maxCohortLogLossRegression: config.predictionModelOpsMaxCohortLogLossRegression,
    },
  };
}


function runTrainingWorker(options) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('../../scripts/train-phase6-worker.js', import.meta.url)), [], {
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('message', (message) => {
      if (message?.type === 'result') resolve(message.result);
      if (message?.type === 'error') reject(new Error(message.message));
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Phase 6 training worker exited with code ${code}: ${stderr.slice(-1000)}`));
    });
    child.send({ type: 'train', options });
  });
}

export async function runPredictionModelOpsTick(now = new Date()) {
  if (!config.predictionModelOpsEnabled) return { skipped: true, reason: 'model_ops_disabled' };
  if (running) return { skipped: true, reason: 'tick_already_running' };
  running = true;
  const client = await pool.connect();
  try {
    const lock = await client.query(
      `SELECT pg_try_advisory_lock(hashtext('fifoo:prediction-model-ops')::bigint) AS locked`,
    );
    if (!lock.rows?.[0]?.locked) return { skipped: true, reason: 'locked_by_another_instance' };
    try {
      const result = await runPredictionModelLifecycle(client, { now, config: lifecycleConfig(), trainingExecutor: runTrainingWorker });
      logger.info('prediction model ops tick complete', result);
      return result;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('fifoo:prediction-model-ops')::bigint)`);
    }
  } catch (error) {
    logger.error('prediction model ops tick failed', { error });
    throw error;
  } finally {
    client.release();
    running = false;
  }
}

export function startPredictionModelOpsScheduler() {
  if (!config.predictionModelOpsEnabled || startupHandle || intervalHandle) return false;
  const run = () => runPredictionModelOpsTick().catch((error) => {
    logger.error('prediction model ops scheduled tick crashed', { error });
  });
  startupHandle = setTimeout(() => {
    startupHandle = null;
    run();
    intervalHandle = setInterval(run, config.predictionModelOpsIntervalMs);
    intervalHandle.unref?.();
  }, config.predictionModelOpsStartupDelayMs);
  startupHandle.unref?.();
  logger.info('prediction model ops scheduler started', {
    intervalMs: config.predictionModelOpsIntervalMs,
    startupDelayMs: config.predictionModelOpsStartupDelayMs,
    runtimeMode: config.predictionRuntimeMode,
  });
  return true;
}

export function stopPredictionModelOpsScheduler() {
  if (startupHandle) clearTimeout(startupHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startupHandle = null;
  intervalHandle = null;
  running = false;
}
