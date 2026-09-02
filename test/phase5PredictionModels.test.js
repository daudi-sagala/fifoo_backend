import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHierarchy,
  cohortKeyForExample,
  completionLabel,
  predictionMetrics,
} from '../src/ml/completionModel.js';
import { trainCompletionHierarchy } from '../src/services/modelTraining.js';
import { optimizeDayRoutes } from '../src/algorithms/routingEngine.js';
import {
  promotePredictionDeployment,
  scoreCandidatesForRouting,
} from '../src/services/predictionService.js';

const userA = 'a12b3456-c789-4def-8123-456789abcdef';
const userB = 'b12b3456-c789-4def-8123-456789abcdef';
const modelID = 'c12b3456-c789-4def-8123-456789abcdef';
const dayMapID = 'd12b3456-c789-4def-8123-456789abcdef';

function behavioral(rate, samples) {
  const stats = {
    sampleCount: samples,
    completionRate: rate,
    skipRate: 1 - rate,
    partialRate: 0,
    averageCompletionScore: rate,
    earnedPotentialRatio: rate,
  };
  return {
    allTime: stats,
    trailing7Days: stats,
    trailing30Days: stats,
    byKind: { workout: stats, task: stats },
    byTimeBucket: { morning: stats, afternoon: stats, evening: stats },
  };
}

function syntheticExamples(count = 360) {
  const start = Date.UTC(2026, 0, 1, 8, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const completed = index % 5 < 3;
    const kind = index % 2 === 0 ? 'workout' : 'task';
    const preferenceFit = completed ? 0.92 : 0.08;
    const historyRate = completed ? 0.78 : 0.32;
    const decisionSecond = index % 3 === 0 ? 9 * 3600 : (index % 3 === 1 ? 14 * 3600 : 19 * 3600);
    return {
      routing_decision_event_id: `decision-${index}`,
      learning_decision_candidate_id: `candidate-${index}`,
      user_id: index % 4 === 0 ? userB : userA,
      map_date: new Date(start + index * 3600_000).toISOString().slice(0, 10),
      decision_at: new Date(start + index * 3600_000).toISOString(),
      decision_second: decisionSecond,
      decision_type: index % 7 === 0 ? 'future_reroute' : 'initial_day_plan',
      reroute_reason: index % 7 === 0 ? 'skip' : null,
      context_data: { behavioralFeatures: behavioral(historyRate, Math.max(1, index % 80)) },
      progress_snapshot: { dayProgress: Math.min(0.95, (index % 20) / 20), expectedDayFinish: 0.75 },
      candidate_kind: kind,
      candidate_rank: index % 3,
      candidate_features: {
        durationSeconds: kind === 'workout' ? 1800 : 900,
        earliestStartSecond: decisionSecond,
        latestEndSecond: decisionSecond + 7200,
        fixedStartSecond: null,
        progressWeightHint: 10,
        goalImpact: 0.7,
        priority: 0.6,
        urgency: 0.5,
        preferenceFit,
        contextFit: completed ? 0.8 : 0.3,
        momentumFit: 0.5,
        effortCost: kind === 'workout' ? 0.65 : 0.25,
        fatigueCost: kind === 'workout' ? 0.55 : 0.2,
        transitionCost: 0.1,
        required: false,
        hardExcluded: false,
        progressCategory: kind === 'workout' ? 'movement' : 'other',
      },
      actual_status: completed ? 'completed' : 'skipped',
      completion_score: completed ? 1 : 0,
      potential_points: 10,
      earned_points: completed ? 10 : 0,
    };
  });
}

test('population model uses chronological holdout and clears offline gates on learnable data', () => {
  const trained = trainCompletionHierarchy(syntheticExamples(), {
    gates: {
      minTestExamples: 40,
      maxLogLoss: 0.55,
      maxBrier: 0.18,
      maxECE: 0.15,
      minAUC: 0.90,
      requireBaselineImprovement: true,
    },
    minimumIndividualSamples: 3,
  });
  assert.ok(trained.split.train.at(-1).decision_at < trained.split.validation[0].decision_at);
  assert.ok(trained.split.validation.at(-1).decision_at < trained.split.test[0].decision_at);
  assert.equal(trained.safetyGateResult.passed, true);
  assert.ok(trained.metrics.logLoss < trained.baselineMetrics.logLoss);
  assert.ok(trained.metrics.auc > 0.9);
  assert.ok(trained.cohorts.length >= 2);
  assert.ok(trained.users.some((row) => row.key === userA));
});

test('cohort and personalized residuals layer on the calibrated population prediction', () => {
  const result = applyHierarchy({
    populationProbability: 0.50,
    cohort: { logitOffset: 0.40, sampleCount: 80 },
    individual: { logitOffset: 0.55, sampleCount: 30 },
  });
  assert.ok(result.cohortProbability > result.populationProbability);
  assert.ok(result.personalizedProbability > result.cohortProbability);
  assert.equal(result.finalProbability, result.personalizedProbability);
  assert.equal(result.predictionLevel, 'personalized');
});

test('cohort key is built only from decision-time candidate/time/behavior context', () => {
  const row = syntheticExamples(1)[0];
  assert.match(cohortKeyForExample(row), /^kind=workout\|daypart=/);
  assert.equal(completionLabel(row), 1);
});

test('runtime shadow scoring records learned probabilities but keeps legacy routing probability', async () => {
  const trained = trainCompletionHierarchy(syntheticExamples());
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM prediction_model_deployments')) {
        return { rowCount: 1, rows: [{
          deployment_mode: 'active', rollout_percent: 100,
          prediction_model_id: modelID, model_name: 'completion-probability', model_version: 1,
          model_status: 'active', model_artifact: trained.modelArtifact,
          calibration_artifact: trained.calibrationArtifact,
          feature_schema_version: 1, policy_version: 'phase4-v1',
        }] };
      }
      if (sql.includes('FROM learning_outcome_observations')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM prediction_model_cohorts')) {
        return { rowCount: 1, rows: [{
          cohort_key: 'kind=workout|daypart=morning|behavior=new',
          sample_count: 30, logit_offset: 0.3, shrinkage_weight: 0.4,
        }] };
      }
      if (sql.includes('FROM prediction_model_users')) {
        return { rowCount: 1, rows: [{ sample_count: 20, logit_offset: 0.25, shrinkage_weight: 0.5 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const result = await scoreCandidatesForRouting(client, {
    configuredMode: 'shadow',
    userID: userA,
    dayMap: { day_map_id: dayMapID },
    mapDate: '2026-09-02',
    decisionSecond: 9 * 3600,
    candidates: [{
      key: 'morning-workout', candidateKey: 'morning-workout', kind: 'workout',
      durationSeconds: 1800, earliestStartSecond: 9 * 3600, latestEndSecond: 11 * 3600,
      completionProbability: 0.65, preferenceFit: 0.9, contextFit: 0.8,
    }],
    routingContext: { decisionType: 'future_reroute' },
    persistScores: true,
  });
  assert.equal(result.predictionMode, 'shadow-model');
  assert.equal(result.candidates[0].completionProbability, 0.65);
  assert.notEqual(result.candidates[0].modelCompletionProbability, null);
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO prediction_score_runs')));
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO prediction_score_events')));
});

test('runtime active scoring can supply personalized completion probability to router', async () => {
  const trained = trainCompletionHierarchy(syntheticExamples());
  const client = {
    async query(sql) {
      if (sql.includes('FROM prediction_model_deployments')) {
        return { rowCount: 1, rows: [{
          deployment_mode: 'active', rollout_percent: 100,
          prediction_model_id: modelID, model_name: 'completion-probability', model_version: 2,
          model_status: 'active', model_artifact: trained.modelArtifact,
          calibration_artifact: trained.calibrationArtifact,
        }] };
      }
      if (sql.includes('FROM learning_outcome_observations')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM prediction_model_cohorts')) return { rowCount: 0, rows: [] };
      if (sql.includes('FROM prediction_model_users')) {
        return { rowCount: 1, rows: [{ sample_count: 25, logit_offset: 0.45, shrinkage_weight: 0.5 }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const result = await scoreCandidatesForRouting(client, {
    configuredMode: 'active',
    userID: userA,
    dayMap: { day_map_id: dayMapID },
    mapDate: '2026-09-02',
    decisionSecond: 9 * 3600,
    candidates: [{
      key: 'workout', kind: 'workout', durationSeconds: 1800,
      earliestStartSecond: 9 * 3600, latestEndSecond: 12 * 3600,
      completionProbability: 0.65, preferenceFit: 0.9, contextFit: 0.8,
    }],
    persistScores: false,
  });
  assert.equal(result.model.effectiveMode, 'active');
  assert.equal(result.candidates[0].completionProbability, result.candidates[0].modelCompletionProbability);
  assert.notEqual(result.candidates[0].completionProbability, 0.65);
});


test('active learned completion probability changes only ranking, not routing constraints', () => {
  const result = optimizeDayRoutes({
    candidates: [
      {
        key: 'low-probability', decisionGroup: 'exercise', kind: 'workout', required: true,
        durationSeconds: 1800, earliestStartSecond: 10 * 3600, latestEndSecond: 13 * 3600,
        completionProbability: 0.15, goalImpact: 0.7, priority: 0.5, preferenceFit: 0.5,
      },
      {
        key: 'high-probability', decisionGroup: 'exercise', kind: 'workout', required: true,
        durationSeconds: 1800, earliestStartSecond: 10 * 3600, latestEndSecond: 13 * 3600,
        completionProbability: 0.92, goalImpact: 0.7, priority: 0.5, preferenceFit: 0.5,
      },
    ],
    context: { predictionModeOverride: 'personalized-model' },
    alternativeCount: 1,
  });
  assert.ok(result.chosenPath.selectedCandidateKeys.includes('high-probability'));
  assert.equal(result.predictionMode, 'personalized-model');
  assert.equal(result.chosenPath.intervals[0].startSecond, 0);
  assert.equal(result.chosenPath.intervals.at(-1).endSecond, 86_400);
});

test('active promotion rejects a model whose offline safety gates failed', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('FROM prediction_models')) {
        return { rowCount: 1, rows: [{
          prediction_model_id: modelID,
          model_status: 'draft',
          safety_gate_result: { passed: false, reasons: ['auc_gate_failed'] },
        }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  await assert.rejects(
    promotePredictionDeployment(client, { modelID, mode: 'active' }),
    /cannot be activated/i,
  );
});


test('active promotion can require labeled shadow superiority over legacy', async () => {
  const updates = [];
  const client = {
    async query(sql) {
      if (sql.includes('FROM prediction_models')) {
        return { rowCount: 1, rows: [{
          prediction_model_id: modelID,
          model_status: 'shadow',
          safety_gate_result: { passed: true },
        }] };
      }
      if (sql.includes('FROM prediction_shadow_evaluation_v1')) {
        return { rowCount: 4, rows: [
          { legacy_probability: 0.55, final_probability: 0.92, actual_status: 'completed' },
          { legacy_probability: 0.55, final_probability: 0.86, actual_status: 'completed' },
          { legacy_probability: 0.55, final_probability: 0.12, actual_status: 'skipped' },
          { legacy_probability: 0.55, final_probability: 0.18, actual_status: 'skipped' },
        ] };
      }
      updates.push(sql);
      return { rowCount: 1, rows: [] };
    },
  };
  await promotePredictionDeployment(client, {
    modelID,
    mode: 'active',
    minimumShadowLabels: 4,
    requireShadowImprovement: true,
  });
  assert.ok(updates.some((sql) => sql.includes('prediction_model_deployments')));
});

test('prediction metrics report calibration/ranking quality', () => {
  const metrics = predictionMetrics([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]);
  assert.equal(metrics.sampleCount, 4);
  assert.equal(metrics.auc, 1);
  assert.ok(metrics.brier < 0.05);
});
