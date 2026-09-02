import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { runPredictionModelLifecycle } from '../src/services/modelOps.js';
import { parseRolloutSteps } from '../src/services/modelOps.js';

const client = await pool.connect();
try {
  const result = await runPredictionModelLifecycle(client, {
    now: new Date(),
    config: {
      enabled: true,
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
      rolloutSteps: parseRolloutSteps(config.predictionModelOpsRolloutSteps.join(',')),
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
    },
  });
  console.log(JSON.stringify({ success: true, ...result }, null, 2));
} finally {
  client.release();
  await pool.end();
}
