import crypto from 'node:crypto';
import {
  applyCalibration,
  applyHierarchy,
  cohortKeyForExample,
  predictPopulationCompletion,
  predictionMetrics,
} from '../ml/completionModel.js';
import { buildBehavioralFeatureSnapshot } from './learningData.js';

const MODEL_NAME = 'completion-probability';

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function legacyProbability(candidate) {
  return clamp(
    candidate.completionProbability
      ?? candidate.populationCompletionProbability
      ?? 0.65,
  );
}

function normalizedMode(value) {
  const mode = String(value ?? 'legacy').toLowerCase();
  return ['legacy', 'shadow', 'active'].includes(mode) ? mode : 'legacy';
}

function rolloutEligible(userID, percent) {
  const rollout = Math.max(0, Math.min(100, Number(percent) || 0));
  if (rollout >= 100) return true;
  if (rollout <= 0) return false;
  const digest = crypto.createHash('sha256').update(String(userID)).digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < rollout;
}

function capMode(configuredMode, deploymentMode) {
  if (configuredMode === 'legacy' || deploymentMode === 'disabled') return 'legacy';
  if (configuredMode === 'shadow') return 'shadow';
  return deploymentMode === 'active' ? 'active' : 'shadow';
}

async function loadDeployment(client, configuredMode, userID) {
  if (configuredMode === 'legacy') return null;
  try {
    const result = await client.query(
      `SELECT
         d.deployment_mode,d.rollout_percent,d.deployment_metadata,
         m.prediction_model_id,m.model_name,m.model_version,m.model_status,
         m.model_artifact,m.calibration_artifact,m.feature_schema_version,m.policy_version
       FROM prediction_model_deployments d
       JOIN prediction_models m ON m.prediction_model_id=d.prediction_model_id
      WHERE d.deployment_key='completion_probability'
        AND m.model_name=$1
        AND m.model_status IN ('shadow','active')
      LIMIT 1`,
      [MODEL_NAME],
    );
    const row = result.rows?.[0];
    if (!row || !row.prediction_model_id) return null;
    if (!rolloutEligible(userID, row.rollout_percent)) return null;
    const effectiveMode = capMode(configuredMode, row.deployment_mode);
    if (effectiveMode === 'legacy') return null;
    return { ...row, effectiveMode };
  } catch {
    // Phase 5 is designed to fail safely: an unavailable model registry never
    // prevents routing. The deterministic/legacy probability remains usable.
    return null;
  }
}

async function loadCohorts(client, modelID, keys) {
  if (!keys.length) return new Map();
  const result = await client.query(
    `SELECT cohort_key,sample_count,logit_offset,shrinkage_weight
       FROM prediction_model_cohorts
      WHERE prediction_model_id=$1 AND cohort_key=ANY($2::text[])`,
    [modelID, [...new Set(keys)]],
  );
  return new Map((result.rows ?? []).map((row) => [row.cohort_key, {
    sampleCount: Number(row.sample_count ?? 0),
    logitOffset: Number(row.logit_offset ?? 0),
    shrinkageWeight: Number(row.shrinkage_weight ?? 0),
  }]));
}

async function loadIndividual(client, modelID, userID) {
  const result = await client.query(
    `SELECT sample_count,logit_offset,shrinkage_weight
       FROM prediction_model_users
      WHERE prediction_model_id=$1 AND user_id=$2`,
    [modelID, userID],
  );
  const row = result.rows?.[0];
  if (!row) return null;
  return {
    sampleCount: Number(row.sample_count ?? 0),
    logitOffset: Number(row.logit_offset ?? 0),
    shrinkageWeight: Number(row.shrinkage_weight ?? 0),
  };
}

function inferenceExample({ candidate, decisionSecond, routingContext, behavioralFeatures, progressSnapshot }) {
  return {
    decisionSecond,
    decisionType: routingContext?.decisionType ?? 'future_reroute',
    rerouteReason: routingContext?.rerouteReason ?? null,
    candidateKind: candidate.kind ?? candidate.intervalKind ?? 'other',
    candidateRank: candidate.candidateRank ?? 0,
    candidateFeatures: candidate,
    contextData: {
      ...(routingContext ?? {}),
      behavioralFeatures,
    },
    progressSnapshot: progressSnapshot ?? {},
  };
}

async function persistScoreRun(client, {
  deployment,
  userID,
  dayMap,
  mapDate,
  requestID,
  configuredMode,
  effectiveMode,
  occurredAt,
  routingContext,
  scores,
}) {
  const runID = crypto.randomUUID();
  await client.query(
    `INSERT INTO prediction_score_runs(
       prediction_score_run_id,prediction_model_id,user_id,day_map_id,map_date,request_id,
       configured_mode,effective_mode,model_name,model_version,scored_at,context_data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      runID,
      deployment.prediction_model_id,
      userID,
      dayMap?.day_map_id ?? null,
      mapDate ?? null,
      requestID ?? null,
      configuredMode,
      effectiveMode,
      deployment.model_name,
      Number(deployment.model_version),
      occurredAt ?? new Date().toISOString(),
      JSON.stringify({ decisionSecond: routingContext?.decisionSecond ?? null }),
    ],
  );
  for (const score of scores) {
    await client.query(
      `INSERT INTO prediction_score_events(
         prediction_score_run_id,candidate_key,source_node_id,candidate_kind,cohort_key,
         population_probability,cohort_probability,personalized_probability,final_probability,
         legacy_probability,applied_probability,prediction_level,cohort_sample_count,
         individual_sample_count,score_metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
      [
        runID,
        score.candidateKey,
        score.sourceNodeID ?? null,
        score.candidateKind,
        score.cohortKey,
        score.populationProbability,
        score.cohortProbability,
        score.personalizedProbability,
        score.finalProbability,
        score.legacyProbability,
        score.appliedProbability,
        score.predictionLevel,
        score.cohortSampleCount,
        score.individualSampleCount,
        JSON.stringify({ modelApplied: effectiveMode === 'active' }),
      ],
    );
  }
  return runID;
}

export async function scoreCandidatesForRouting(client, {
  configuredMode = 'legacy',
  userID,
  dayMap,
  mapDate,
  decisionSecond = 0,
  candidates = [],
  routingContext = {},
  progressSnapshot = null,
  requestID = null,
  occurredAt = new Date().toISOString(),
  persistScores = true,
} = {}) {
  const mode = normalizedMode(configuredMode);
  const legacyCandidates = candidates.map((candidate) => ({
    ...candidate,
    completionProbability: legacyProbability(candidate),
  }));
  if (mode === 'legacy' || !legacyCandidates.length) {
    return {
      candidates: legacyCandidates,
      predictionMode: 'legacy',
      model: null,
      predictionScoreRunID: null,
    };
  }

  const deployment = await loadDeployment(client, mode, userID);
  if (!deployment) {
    return {
      candidates: legacyCandidates,
      predictionMode: 'legacy-fallback',
      model: null,
      predictionScoreRunID: null,
    };
  }

  let behavioralSnapshot;
  try {
    behavioralSnapshot = await buildBehavioralFeatureSnapshot(client, {
      userID,
      asOf: occurredAt,
    });
  } catch {
    return {
      candidates: legacyCandidates,
      predictionMode: 'legacy-fallback',
      model: null,
      predictionScoreRunID: null,
    };
  }

  const examples = legacyCandidates.map((candidate, candidateRank) => inferenceExample({
    candidate: { ...candidate, candidateRank },
    decisionSecond,
    routingContext,
    behavioralFeatures: behavioralSnapshot.featureData,
    progressSnapshot,
  }));
  const cohortKeys = examples.map(cohortKeyForExample);
  const cohorts = await loadCohorts(client, deployment.prediction_model_id, cohortKeys);
  const individual = await loadIndividual(client, deployment.prediction_model_id, userID);
  const scores = [];
  const scoredCandidates = legacyCandidates.map((candidate, index) => {
    const raw = predictPopulationCompletion(deployment.model_artifact, examples[index]);
    const populationProbability = applyCalibration(deployment.calibration_artifact, raw);
    const cohort = cohorts.get(cohortKeys[index]) ?? null;
    const hierarchy = applyHierarchy({ populationProbability, cohort, individual });
    const legacy = legacyProbability(candidate);
    const applied = deployment.effectiveMode === 'active' ? hierarchy.finalProbability : legacy;
    scores.push({
      candidateKey: String(candidate.candidateKey ?? candidate.key ?? `candidate-${index}`),
      sourceNodeID: candidate.sourceNodeID ?? null,
      candidateKind: String(candidate.kind ?? candidate.intervalKind ?? 'other'),
      cohortKey: cohortKeys[index],
      ...hierarchy,
      legacyProbability: legacy,
      appliedProbability: applied,
      cohortSampleCount: cohort?.sampleCount ?? 0,
      individualSampleCount: individual?.sampleCount ?? 0,
    });
    return {
      ...candidate,
      completionProbability: applied,
      modelCompletionProbability: hierarchy.finalProbability,
      legacyCompletionProbability: legacy,
      predictionLevel: hierarchy.predictionLevel,
    };
  });

  let predictionScoreRunID = null;
  if (persistScores) {
    try {
      predictionScoreRunID = await persistScoreRun(client, {
        deployment,
        userID,
        dayMap,
        mapDate,
        requestID,
        configuredMode: mode,
        effectiveMode: deployment.effectiveMode,
        occurredAt,
        routingContext: { ...routingContext, decisionSecond },
        scores,
      });
    } catch {
      // Score logging is observational. It must never make a route unavailable.
      predictionScoreRunID = null;
    }
  }

  return {
    candidates: scoredCandidates,
    predictionMode: deployment.effectiveMode === 'active'
      ? (individual ? 'personalized-model' : (cohorts.size ? 'cohort-model' : 'population-model'))
      : 'shadow-model',
    model: {
      predictionModelID: deployment.prediction_model_id,
      name: deployment.model_name,
      version: Number(deployment.model_version),
      effectiveMode: deployment.effectiveMode,
    },
    predictionScoreRunID,
    scores,
  };
}

export async function linkPredictionScoreRun(client, predictionScoreRunID, routingDecisionEventID) {
  if (!predictionScoreRunID || !routingDecisionEventID) return false;
  await client.query(
    `UPDATE prediction_score_runs
        SET routing_decision_event_id=$2
      WHERE prediction_score_run_id=$1 AND routing_decision_event_id IS NULL`,
    [predictionScoreRunID, routingDecisionEventID],
  );
  return true;
}

export async function promotePredictionDeployment(client, {
  modelID,
  mode = 'shadow',
  rolloutPercent = 100,
  metadata = {},
  minimumShadowLabels = 0,
  requireShadowImprovement = false,
} = {}) {
  const normalized = String(mode).toLowerCase();
  if (!['shadow', 'active', 'disabled'].includes(normalized)) {
    throw new TypeError('Prediction deployment mode must be shadow, active, or disabled.');
  }
  if (normalized !== 'disabled' && !modelID) throw new TypeError('modelID is required for shadow/active deployment.');

  if (modelID) {
    const model = await client.query(
      `SELECT prediction_model_id,model_status,safety_gate_result
         FROM prediction_models
        WHERE prediction_model_id=$1 AND model_name=$2`,
      [modelID, MODEL_NAME],
    );
    if (!model.rowCount) throw new RangeError('Prediction model does not exist.');
    const row = model.rows[0];
    if (normalized === 'active' && row.safety_gate_result?.passed !== true) {
      throw new RangeError('A model cannot be activated until its offline safety gates pass.');
    }
    if (normalized === 'active' && (minimumShadowLabels > 0 || requireShadowImprovement)) {
      const shadow = await client.query(
        `SELECT legacy_probability,final_probability,actual_status
           FROM prediction_shadow_evaluation_v1
          WHERE prediction_model_id=$1 AND actual_status IS NOT NULL
          ORDER BY observed_at DESC
          LIMIT 10000`,
        [modelID],
      );
      const labels = shadow.rows.map((entry) => (
        String(entry.actual_status).toLowerCase() === 'completed' ? 1 : 0
      ));
      if (labels.length < minimumShadowLabels) {
        throw new RangeError(`A model requires at least ${minimumShadowLabels} labeled shadow scores before activation.`);
      }
      if (requireShadowImprovement && labels.length) {
        const legacyMetrics = predictionMetrics(
          shadow.rows.map((entry) => Number(entry.legacy_probability)),
          labels,
        );
        const learnedMetrics = predictionMetrics(
          shadow.rows.map((entry) => Number(entry.final_probability)),
          labels,
        );
        if (learnedMetrics.logLoss >= legacyMetrics.logLoss || learnedMetrics.brier > legacyMetrics.brier) {
          throw new RangeError('Shadow evaluation does not outperform the legacy completion probabilities.');
        }
      }
    }
    await client.query(
      `UPDATE prediction_models
          SET model_status=$2,
              activated_at=CASE WHEN $2='active' THEN NOW() ELSE activated_at END
        WHERE prediction_model_id=$1`,
      [modelID, normalized === 'active' ? 'active' : 'shadow'],
    );
  }

  await client.query(
    `INSERT INTO prediction_model_deployments(
       deployment_key,prediction_model_id,deployment_mode,rollout_percent,deployment_metadata,updated_at
     ) VALUES ('completion_probability',$1,$2,$3,$4::jsonb,NOW())
     ON CONFLICT(deployment_key) DO UPDATE SET
       prediction_model_id=EXCLUDED.prediction_model_id,
       deployment_mode=EXCLUDED.deployment_mode,
       rollout_percent=EXCLUDED.rollout_percent,
       deployment_metadata=EXCLUDED.deployment_metadata,
       updated_at=NOW()`,
    [modelID ?? null, normalized, Math.max(0, Math.min(100, Number(rolloutPercent) || 0)), JSON.stringify(metadata)],
  );
  return true;
}

export const predictionServiceInternals = Object.freeze({
  legacyProbability,
  normalizedMode,
  rolloutEligible,
  capMode,
  inferenceExample,
});
