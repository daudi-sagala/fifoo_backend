import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePredictionHealth,
  monitoringReference,
  parseRolloutSteps,
  populationStabilityIndex,
  probabilityHistogram,
  modelOpsInternals,
} from '../src/services/modelOps.js';
import {
  predictionServiceInternals,
  scoreCandidatesForRouting,
} from '../src/services/predictionService.js';
import { trainCompletionHierarchy } from '../src/services/modelTraining.js';

const modelID = 'a12b3456-c789-4def-8123-456789abcdef';
const fallbackID = 'b12b3456-c789-4def-8123-456789abcdef';
const challengerID = 'c12b3456-c789-4def-8123-456789abcdef';
const userID = 'd12b3456-c789-4def-8123-456789abcdef';
const dayMapID = 'e12b3456-c789-4def-8123-456789abcdef';

function examples(count = 160) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const completed = index % 4 !== 0;
    const hour = 7 + (index % 12);
    rows.push({
      user_id: `${String((index % 12) + 1).padStart(8, '0')}-1111-4abc-8123-456789abcdef`,
      decision_at: new Date(Date.UTC(2026, 0, 1 + index, 12)).toISOString(),
      decision_second: hour * 3600,
      decision_type: 'future_reroute',
      reroute_reason: index % 5 === 0 ? 'skip' : 'constraint_changed',
      candidate_kind: index % 2 ? 'workout' : 'meal',
      candidate_rank: index % 3,
      candidate_features: {
        durationSeconds: 900 + (index % 4) * 600,
        earliestStartSecond: hour * 3600,
        latestEndSecond: (hour + 2) * 3600,
        goalImpact: completed ? 0.9 : 0.2,
        preferenceFit: completed ? 0.9 : 0.25,
        contextFit: completed ? 0.85 : 0.2,
        priority: 0.6,
        urgency: 0.5,
        progressCategory: index % 2 ? 'exercise' : 'food',
      },
      context_data: {
        behavioralFeatures: {
          allTime: { sampleCount: 20 + index, completionRate: completed ? 0.8 : 0.3, averageCompletionScore: completed ? 0.85 : 0.35 },
          trailing7Days: { sampleCount: 5, completionRate: completed ? 0.8 : 0.2 },
          trailing30Days: { sampleCount: 12, completionRate: completed ? 0.75 : 0.25 },
          byKind: {},
          byTimeBucket: {},
        },
      },
      progress_snapshot: { dayProgress: 0.2, expectedDayFinish: 0.6 },
      actual_status: completed ? 'completed' : 'skipped',
    });
  }
  return rows;
}

function healthyRows(count = 120) {
  return Array.from({ length: count }, (_, index) => {
    const completed = index % 2 === 0;
    return {
      final_probability: completed ? 0.82 : 0.18,
      legacy_probability: completed ? 0.62 : 0.58,
      actual_status: completed ? 'completed' : 'skipped',
      scored_at: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
      observed_at: new Date(Date.UTC(2026, 8, 1, 1, index)).toISOString(),
    };
  });
}

test('rollout steps are normalized and always terminate at 100 percent', () => {
  assert.deepEqual(parseRolloutSteps('50,10,25,25'), [10, 25, 50, 100]);
  assert.deepEqual(parseRolloutSteps('bad'), [100]);
  assert.equal(modelOpsInternals.nextRollout(25, [10, 25, 50, 100]), 50);
});

test('prediction distribution PSI is zero for identical populations and rises on drift', () => {
  const reference = probabilityHistogram([0.1, 0.2, 0.8, 0.9], 4);
  assert.ok(Math.abs(populationStabilityIndex(reference, reference)) < 1e-12);
  const shifted = probabilityHistogram([0.8, 0.85, 0.9, 0.95], 4);
  assert.ok(populationStabilityIndex(reference, shifted) > 0.25);
});

test('health gate stays insufficient until enough real labels arrive', () => {
  const rows = healthyRows(10);
  const reference = monitoringReference(rows.map((row) => row.final_probability), rows.map((row) => row.actual_status === 'completed' ? 1 : 0));
  const health = evaluatePredictionHealth(rows, reference, { minimumLabels: 30 });
  assert.equal(health.healthStatus, 'insufficient');
  assert.ok(health.reasons.includes('insufficient_labeled_predictions'));
});

test('healthy shadow predictions can clear learned-vs-legacy and drift gates', () => {
  const rows = healthyRows();
  const reference = monitoringReference(rows.map((row) => row.final_probability), rows.map((row) => row.actual_status === 'completed' ? 1 : 0));
  const health = evaluatePredictionHealth(rows, reference, {
    minimumLabels: 50,
    requireLearnedImprovement: true,
    minLogLossImprovement: 0.001,
  });
  assert.equal(health.healthStatus, 'healthy');
  assert.ok(health.learnedMetrics.logLoss < health.legacyMetrics.logLoss);
});

test('health gate detects model regression or material distribution drift', () => {
  const reference = monitoringReference([0.15, 0.2, 0.8, 0.85, 0.2, 0.8], [0, 0, 1, 1, 0, 1]);
  const rows = Array.from({ length: 60 }, (_, index) => ({
    final_probability: index % 2 ? 0.92 : 0.88,
    legacy_probability: index % 2 ? 0.8 : 0.2,
    actual_status: index % 2 ? 'completed' : 'skipped',
  }));
  const health = evaluatePredictionHealth(rows, reference, {
    minimumLabels: 30,
    maxPSI: 0.1,
    maxLogLossRegression: 0,
    maxBrierRegression: 0,
  });
  assert.equal(health.healthStatus, 'unhealthy');
  assert.ok(health.reasons.includes('prediction_distribution_drift') || health.reasons.includes('log_loss_regression'));
});

test('training artifact stores monitoring reference for future drift checks', () => {
  const trained = trainCompletionHierarchy(examples(), {
    gates: { minTestExamples: 10, minAUC: 0, maxLogLoss: 5, maxBrier: 1, maxECE: 1, requireBaselineImprovement: false },
  });
  assert.ok(trained.metadata.monitoringReference.sampleCount > 0);
  assert.equal(trained.metadata.monitoringReference.probabilityHistogram.length, 10);
});

test('canary users outside challenger rollout keep the previous active champion', async () => {
  const trained = trainCompletionHierarchy(examples(), {
    gates: { minTestExamples: 10, minAUC: 0, maxLogLoss: 5, maxBrier: 1, maxECE: 1, requireBaselineImprovement: false },
  });
  let outside = userID;
  let suffix = 0;
  while (predictionServiceInternals.rolloutEligible(outside, 1)) {
    suffix += 1;
    outside = `d12b3456-c789-4def-8123-${String(456789000000 + suffix).padStart(12, '0')}`;
  }
  const client = {
    async query(sql, parameters = []) {
      if (sql.includes('FROM prediction_model_deployments')) {
        return { rowCount: 1, rows: [{
          deployment_mode: 'active', rollout_percent: 1,
          prediction_model_id: modelID, fallback_prediction_model_id: fallbackID,
          challenger_prediction_model_id: null,
          model_name: 'completion-probability', model_version: 3, model_status: 'active',
          model_artifact: trained.modelArtifact, calibration_artifact: trained.calibrationArtifact,
        }] };
      }
      if (sql.includes('FROM prediction_models')) {
        assert.equal(parameters[0], fallbackID);
        return { rowCount: 1, rows: [{
          prediction_model_id: fallbackID, model_name: 'completion-probability', model_version: 2,
          model_status: 'active', model_artifact: trained.modelArtifact, calibration_artifact: trained.calibrationArtifact,
        }] };
      }
      if (sql.includes('FROM learning_outcome_observations')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM prediction_model_cohorts')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM prediction_model_users')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
  const result = await scoreCandidatesForRouting(client, {
    configuredMode: 'active', userID: outside, dayMap: { day_map_id: dayMapID },
    decisionSecond: 36_000, candidates: [{ key: 'walk', kind: 'workout', completionProbability: 0.65 }],
    persistScores: false,
  });
  assert.equal(result.model.predictionModelID, fallbackID);
  assert.equal(result.model.role, 'fallback-champion');
  assert.equal(result.model.effectiveMode, 'active');
});

test('active champion can score a new shadow challenger without changing applied probability', async () => {
  const trained = trainCompletionHierarchy(examples(), {
    gates: { minTestExamples: 10, minAUC: 0, maxLogLoss: 5, maxBrier: 1, maxECE: 1, requireBaselineImprovement: false },
  });
  const client = {
    async query(sql, parameters = []) {
      if (sql.includes('FROM prediction_model_deployments')) {
        return { rowCount: 1, rows: [{
          deployment_mode: 'active', rollout_percent: 100,
          prediction_model_id: modelID, fallback_prediction_model_id: null,
          challenger_prediction_model_id: challengerID,
          model_name: 'completion-probability', model_version: 3, model_status: 'active',
          model_artifact: trained.modelArtifact, calibration_artifact: trained.calibrationArtifact,
        }] };
      }
      if (sql.includes('FROM prediction_models')) {
        assert.equal(parameters[0], challengerID);
        return { rowCount: 1, rows: [{
          prediction_model_id: challengerID, model_name: 'completion-probability', model_version: 4,
          model_status: 'shadow', model_artifact: trained.modelArtifact, calibration_artifact: trained.calibrationArtifact,
        }] };
      }
      if (sql.includes('FROM learning_outcome_observations')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM prediction_model_cohorts')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM prediction_model_users')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    },
  };
  const result = await scoreCandidatesForRouting(client, {
    configuredMode: 'active', userID, dayMap: { day_map_id: dayMapID },
    decisionSecond: 36_000, candidates: [{ key: 'walk', kind: 'workout', completionProbability: 0.65 }],
    persistScores: false,
  });
  assert.equal(result.model.predictionModelID, modelID);
  assert.equal(result.model.challengerPredictionModelID, challengerID);
  assert.equal(result.challengerScores.length, 1);
  assert.equal(result.candidates[0].completionProbability, result.scores[0].finalProbability);
});

test('challenger health compares against champion probability when available, not only legacy', () => {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const completed = index % 2 === 0;
    return {
      final_probability: completed ? 0.65 : 0.35,
      comparator_probability: completed ? 0.9 : 0.1,
      legacy_probability: 0.5,
      cohort_key: 'kind=workout|daypart=morning|behavior=medium',
      actual_status: completed ? 'completed' : 'skipped',
    };
  });
  const reference = monitoringReference(rows.map((row) => row.final_probability), rows.map((row) => row.actual_status === 'completed' ? 1 : 0));
  const health = evaluatePredictionHealth(rows, reference, {
    minimumLabels: 30,
    maxLogLossRegression: 0,
    maxBrierRegression: 0,
    maxPSI: 1,
  });
  assert.equal(health.healthStatus, 'unhealthy');
  assert.ok(health.reasons.includes('log_loss_regression'));
  assert.ok(health.comparatorMetrics.logLoss < health.learnedMetrics.logLoss);
});

test('a rollout stage cannot accumulate healthy checks without fresh labeled evidence', () => {
  const { hasNewLabeledEvidence } = modelOpsInternals;
  const old = '2026-09-02T12:00:00.000Z';
  assert.equal(hasNewLabeledEvidence([{ observed_at: '2026-09-02T11:59:59.000Z' }], old), false);
  assert.equal(hasNewLabeledEvidence([{ observed_at: '2026-09-02T12:00:01.000Z' }], old), true);
  assert.equal(hasNewLabeledEvidence([{ observed_at: '2026-09-02T11:00:00.000Z' }], null), true);
});
