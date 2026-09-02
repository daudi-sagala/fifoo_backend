import {
  applyCalibration,
  cohortKeyForExample,
  completionLabel,
  fitPlattCalibration,
  fitResidualCalibrations,
  modelSafetyGates,
  predictPopulationCompletion,
  predictionMetrics,
  temporalSplit,
  trainPopulationCompletionModel,
} from '../ml/completionModel.js';
import { LEARNING_FEATURE_SCHEMA_VERSION, LEARNING_POLICY_VERSION } from './learningData.js';


function probabilityHistogram(probabilities, bins = 10) {
  const totals = new Array(bins).fill(0);
  for (const raw of probabilities ?? []) {
    const p = Math.max(0, Math.min(1 - Number.EPSILON, Number(raw) || 0));
    totals[Math.min(bins - 1, Math.floor(p * bins))] += 1;
  }
  const total = totals.reduce((sum, value) => sum + value, 0);
  return total ? totals.map((value) => value / total) : totals;
}

function monitoringReference(probabilities, labels, bins = 10) {
  const positives = (labels ?? []).reduce((sum, value) => sum + (Number(value) >= 0.5 ? 1 : 0), 0);
  return {
    sampleCount: probabilities?.length ?? 0,
    positiveRate: labels?.length ? positives / labels.length : null,
    probabilityHistogram: probabilityHistogram(probabilities, bins),
    bins,
  };
}

export const COMPLETION_MODEL_NAME = 'completion-probability';
export const COMPLETION_MODEL_FAMILY = 'logistic+hierarchical-calibration';
export const COMPLETION_TRAINING_VIEW = 'learning_completion_examples_v1';

function range(rows) {
  if (!rows.length) return { start: null, end: null };
  return {
    start: rows[0].decision_at ?? rows[0].decisionAt ?? null,
    end: rows.at(-1).decision_at ?? rows.at(-1).decisionAt ?? null,
  };
}

function populationPredictions(modelArtifact, calibrationArtifact, rows) {
  return rows.map((row) => applyCalibration(
    calibrationArtifact,
    predictPopulationCompletion(modelArtifact, row),
  ));
}

function userKey(row) {
  return String(row.user_id ?? row.userID ?? 'unknown');
}

export async function loadCompletionTrainingExamples(client, {
  startDate = null,
  endDate = null,
  limit = 1_000_000,
} = {}) {
  const clauses = [];
  const parameters = [];
  if (startDate) {
    parameters.push(startDate);
    clauses.push(`map_date >= $${parameters.length}::date`);
  }
  if (endDate) {
    parameters.push(endDate);
    clauses.push(`map_date <= $${parameters.length}::date`);
  }
  parameters.push(Math.max(1, Math.min(5_000_000, Number(limit) || 1_000_000)));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await client.query(
    `SELECT * FROM (
       SELECT *
         FROM ${COMPLETION_TRAINING_VIEW}
         ${where}
        ORDER BY decision_at DESC,routing_decision_event_id DESC,learning_decision_candidate_id DESC
        LIMIT $${parameters.length}
     ) recent
     ORDER BY decision_at,routing_decision_event_id,learning_decision_candidate_id`,
    parameters,
  );
  return result.rows ?? [];
}

export function trainCompletionHierarchy(examples, {
  training = {},
  gates = {},
  cohortPriorStrength = 20,
  cohortShrinkageHalfLife = 40,
  individualPriorStrength = 8,
  individualShrinkageHalfLife = 12,
  minimumIndividualSamples = 3,
} = {}) {
  if (!Array.isArray(examples) || examples.length < 3) {
    throw new TypeError('Phase 5 requires at least three chronological completion examples.');
  }
  const split = temporalSplit(examples, training.temporalSplit ?? {});
  if (split.train.length < 2) throw new RangeError('Temporal training split is too small.');

  const modelArtifact = trainPopulationCompletionModel(split.train, training.logistic ?? {});
  const validationRaw = split.validation.map((row) => predictPopulationCompletion(modelArtifact, row));
  const validationLabels = split.validation.map(completionLabel);
  const calibrationArtifact = fitPlattCalibration(validationRaw, validationLabels, training.calibration ?? {});

  const evaluationRows = split.test.length ? split.test : split.validation;
  const evaluationLabels = evaluationRows.map(completionLabel);
  const evaluationPredictions = populationPredictions(modelArtifact, calibrationArtifact, evaluationRows);
  const trainPrevalence = split.train.reduce((sum, row) => sum + completionLabel(row), 0) / split.train.length;
  const baselinePredictions = evaluationRows.map(() => trainPrevalence);
  const metrics = predictionMetrics(evaluationPredictions, evaluationLabels);
  const baselineMetrics = predictionMetrics(baselinePredictions, evaluationLabels);
  const safetyGateResult = modelSafetyGates(metrics, baselineMetrics, gates);
  const monitoring = monitoringReference(evaluationPredictions, evaluationLabels);

  const calibrationRows = [...split.train, ...split.validation];
  const calibrationPopulation = populationPredictions(modelArtifact, calibrationArtifact, calibrationRows);
  const cohorts = fitResidualCalibrations(calibrationRows, calibrationPopulation, {
    keyForExample: cohortKeyForExample,
    priorStrength: cohortPriorStrength,
    shrinkageHalfLife: cohortShrinkageHalfLife,
  });
  const users = fitResidualCalibrations(calibrationRows, calibrationPopulation, {
    keyForExample: userKey,
    priorStrength: individualPriorStrength,
    shrinkageHalfLife: individualShrinkageHalfLife,
    minimumSamples: minimumIndividualSamples,
  });

  return {
    split,
    modelArtifact,
    calibrationArtifact,
    metrics,
    baselineMetrics,
    safetyGateResult,
    cohorts,
    users,
    metadata: {
      featureSchemaVersion: LEARNING_FEATURE_SCHEMA_VERSION,
      policyVersion: LEARNING_POLICY_VERSION,
      minimumIndividualSamples,
      cohortPriorStrength,
      cohortShrinkageHalfLife,
      individualPriorStrength,
      individualShrinkageHalfLife,
      monitoringReference: monitoring,
    },
  };
}

async function nextVersion(client, modelName) {
  const result = await client.query(
    `SELECT COALESCE(MAX(model_version),0)::int + 1 AS next_version
       FROM prediction_models
      WHERE model_name=$1`,
    [modelName],
  );
  return Number(result.rows?.[0]?.next_version ?? 1);
}

export async function persistCompletionHierarchy(client, trained, {
  modelName = COMPLETION_MODEL_NAME,
  modelStatus = null,
  autoDeployShadow = true,
} = {}) {
  const version = await nextVersion(client, modelName);
  const trainRange = range(trained.split.train);
  const validationRange = range(trained.split.validation);
  const testRange = range(trained.split.test);
  const status = modelStatus ?? (trained.safetyGateResult.passed ? 'shadow' : 'draft');

  const inserted = await client.query(
    `INSERT INTO prediction_models(
       model_name,model_family,model_version,model_status,training_view,
       feature_schema_version,policy_version,model_artifact,calibration_artifact,
       training_metrics,baseline_metrics,safety_gate_result,
       train_window_start,train_window_end,validation_window_start,validation_window_end,
       test_window_start,test_window_end,train_example_count,validation_example_count,test_example_count,
       trained_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,
       $13,$14,$15,$16,$17,$18,$19,$20,$21,NOW()
     ) RETURNING prediction_model_id,model_version,model_status`,
    [
      modelName,
      COMPLETION_MODEL_FAMILY,
      version,
      status,
      COMPLETION_TRAINING_VIEW,
      trained.metadata.featureSchemaVersion,
      trained.metadata.policyVersion,
      JSON.stringify({ ...trained.modelArtifact, metadata: trained.metadata }),
      JSON.stringify(trained.calibrationArtifact),
      JSON.stringify({ ...trained.metrics, monitoringReference: trained.metadata.monitoringReference }),
      JSON.stringify(trained.baselineMetrics),
      JSON.stringify(trained.safetyGateResult),
      trainRange.start,
      trainRange.end,
      validationRange.start,
      validationRange.end,
      testRange.start,
      testRange.end,
      trained.split.train.length,
      trained.split.validation.length,
      trained.split.test.length,
    ],
  );
  const model = inserted.rows[0];

  for (const cohort of trained.cohorts) {
    await client.query(
      `INSERT INTO prediction_model_cohorts(
         prediction_model_id,cohort_key,cohort_dimensions,sample_count,positive_count,
         raw_completion_rate,mean_population_prediction,raw_logit_offset,logit_offset,shrinkage_weight
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10)`,
      [
        model.prediction_model_id,
        cohort.key,
        JSON.stringify(Object.fromEntries(cohort.key.split('|').map((part) => part.split('=')))),
        cohort.sampleCount,
        cohort.positiveCount,
        cohort.rawRate,
        cohort.meanPopulationPrediction,
        cohort.rawLogitOffset,
        cohort.logitOffset,
        cohort.shrinkageWeight,
      ],
    );
  }

  for (const user of trained.users) {
    await client.query(
      `INSERT INTO prediction_model_users(
         prediction_model_id,user_id,sample_count,positive_count,raw_completion_rate,
         mean_population_prediction,raw_logit_offset,logit_offset,shrinkage_weight,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [
        model.prediction_model_id,
        user.key,
        user.sampleCount,
        user.positiveCount,
        user.rawRate,
        user.meanPopulationPrediction,
        user.rawLogitOffset,
        user.logitOffset,
        user.shrinkageWeight,
      ],
    );
  }

  if (status === 'shadow' && autoDeployShadow) {
    await client.query(
      `INSERT INTO prediction_model_deployments(
         deployment_key,prediction_model_id,fallback_prediction_model_id,challenger_prediction_model_id,
         deployment_mode,rollout_percent,deployment_metadata,stage_started_at,automation_managed,
         consecutive_healthy_checks,updated_at
       ) VALUES ('completion_probability',$1,NULL,NULL,'shadow',100,$2::jsonb,NOW(),FALSE,0,NOW())
       ON CONFLICT(deployment_key) DO UPDATE SET
         prediction_model_id=EXCLUDED.prediction_model_id,
         fallback_prediction_model_id=NULL,
         challenger_prediction_model_id=NULL,
         deployment_mode='shadow',
         rollout_percent=100,
         deployment_metadata=EXCLUDED.deployment_metadata,
         stage_started_at=NOW(),
         automation_managed=FALSE,
         consecutive_healthy_checks=0,
         updated_at=NOW()`,
      [model.prediction_model_id, JSON.stringify({ promotedBy: 'phase5-training-gates' })],
    );
  }

  return {
    predictionModelID: model.prediction_model_id,
    modelVersion: Number(model.model_version),
    modelStatus: model.model_status,
  };
}

export async function trainAndPersistCompletionHierarchy(client, options = {}) {
  const examples = await loadCompletionTrainingExamples(client, options.dataset ?? {});
  const trained = trainCompletionHierarchy(examples, options.model ?? {});
  const persisted = await persistCompletionHierarchy(client, trained, options.persistence ?? {});
  return {
    ...persisted,
    exampleCount: examples.length,
    trainCount: trained.split.train.length,
    validationCount: trained.split.validation.length,
    testCount: trained.split.test.length,
    metrics: trained.metrics,
    baselineMetrics: trained.baselineMetrics,
    safetyGateResult: trained.safetyGateResult,
    cohortCount: trained.cohorts.length,
    personalizedUserCount: trained.users.length,
  };
}
