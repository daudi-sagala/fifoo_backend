import {
  predictionMetrics,
} from '../ml/completionModel.js';
import {
  trainAndPersistCompletionHierarchy,
} from './modelTraining.js';
import {
  promotePredictionDeployment,
} from './predictionService.js';

const DEPLOYMENT_KEY = 'completion_probability';
const MODEL_NAME = 'completion-probability';
const EPS = 1e-6;

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, finite(value, minimum)));
}

export function parseRolloutSteps(value = '10,25,50,100') {
  const steps = String(value)
    .split(',')
    .map((entry) => Math.trunc(Number(entry.trim())))
    .filter((entry) => Number.isFinite(entry) && entry > 0 && entry <= 100);
  const unique = [...new Set(steps)].sort((a, b) => a - b);
  if (!unique.length || unique.at(-1) !== 100) unique.push(100);
  return unique;
}

export function probabilityHistogram(probabilities, bins = 10) {
  const count = Math.max(1, Math.trunc(bins));
  const totals = new Array(count).fill(0);
  for (const raw of probabilities ?? []) {
    const p = clamp(raw, 0, 1 - Number.EPSILON);
    const index = Math.min(count - 1, Math.floor(p * count));
    totals[index] += 1;
  }
  const total = totals.reduce((sum, value) => sum + value, 0);
  if (!total) return totals.map(() => 0);
  return totals.map((value) => value / total);
}

export function populationStabilityIndex(reference, current) {
  const length = Math.max(reference?.length ?? 0, current?.length ?? 0);
  if (!length) return null;
  let psi = 0;
  for (let index = 0; index < length; index += 1) {
    const expected = Math.max(EPS, finite(reference?.[index], 0));
    const actual = Math.max(EPS, finite(current?.[index], 0));
    psi += (actual - expected) * Math.log(actual / expected);
  }
  return psi;
}

export function monitoringReference(probabilities, labels, { bins = 10 } = {}) {
  const metrics = predictionMetrics(probabilities ?? [], labels ?? [], { bins });
  return {
    sampleCount: metrics.sampleCount,
    positiveRate: metrics.positiveRate,
    probabilityHistogram: probabilityHistogram(probabilities, bins),
    bins,
  };
}

export function evaluatePredictionHealth(rows, reference = {}, {
  minimumLabels = 30,
  maxLogLossRegression = 0.02,
  maxBrierRegression = 0.01,
  maxECE = 0.18,
  maxPSI = 0.25,
  maxPositiveRateDelta = 0.20,
  minimumCohortLabels = 20,
  maxCohortLogLossRegression = 0.05,
  requireLearnedImprovement = false,
  minLogLossImprovement = 0,
} = {}) {
  const labeled = (rows ?? []).filter((row) => row.actual_status != null);
  const labels = labeled.map((row) => String(row.actual_status).toLowerCase() === 'completed' ? 1 : 0);
  const learned = labeled.map((row) => Number(row.final_probability));
  const legacy = labeled.map((row) => Number(row.legacy_probability));
  const comparator = labeled.map((row) => Number(row.comparator_probability ?? row.legacy_probability));
  const learnedMetrics = predictionMetrics(learned, labels);
  const legacyMetrics = predictionMetrics(legacy, labels);
  const comparatorMetrics = predictionMetrics(comparator, labels);
  const histogram = probabilityHistogram(learned, Number(reference?.bins ?? 10));
  const psi = Array.isArray(reference?.probabilityHistogram)
    ? populationStabilityIndex(reference.probabilityHistogram, histogram)
    : null;
  const positiveRateDelta = reference?.positiveRate == null || learnedMetrics.positiveRate == null
    ? null
    : Math.abs(Number(learnedMetrics.positiveRate) - Number(reference.positiveRate));

  const reasons = [];
  if (labeled.length < minimumLabels) reasons.push('insufficient_labeled_predictions');
  if (labeled.length >= minimumLabels) {
    if (learnedMetrics.logLoss == null
        || comparatorMetrics.logLoss == null
        || learnedMetrics.logLoss > comparatorMetrics.logLoss + maxLogLossRegression) {
      reasons.push('log_loss_regression');
    }
    if (learnedMetrics.brier == null
        || comparatorMetrics.brier == null
        || learnedMetrics.brier > comparatorMetrics.brier + maxBrierRegression) {
      reasons.push('brier_regression');
    }
    if (learnedMetrics.ece != null && learnedMetrics.ece > maxECE) reasons.push('calibration_drift');
    if (psi != null && psi > maxPSI) reasons.push('prediction_distribution_drift');
    if (positiveRateDelta != null && positiveRateDelta > maxPositiveRateDelta) reasons.push('outcome_rate_drift');
    if (requireLearnedImprovement
        && learnedMetrics.logLoss != null
        && comparatorMetrics.logLoss != null
        && learnedMetrics.logLoss > comparatorMetrics.logLoss - minLogLossImprovement) {
      reasons.push('insufficient_shadow_improvement');
    }
  }

  const cohortGroups = new Map();
  for (const row of labeled) {
    const key = String(row.cohort_key ?? 'unknown');
    const group = cohortGroups.get(key) ?? [];
    group.push(row);
    cohortGroups.set(key, group);
  }
  const cohortDiagnostics = [];
  for (const [cohortKey, group] of cohortGroups) {
    if (group.length < minimumCohortLabels) continue;
    const cohortLabels = group.map((row) => String(row.actual_status).toLowerCase() === 'completed' ? 1 : 0);
    const cohortLearned = predictionMetrics(group.map((row) => Number(row.final_probability)), cohortLabels);
    const cohortComparator = predictionMetrics(group.map((row) => Number(row.comparator_probability ?? row.legacy_probability)), cohortLabels);
    const regressed = cohortLearned.logLoss != null && cohortComparator.logLoss != null
      && cohortLearned.logLoss > cohortComparator.logLoss + maxCohortLogLossRegression;
    cohortDiagnostics.push({ cohortKey, sampleCount: group.length, learned: cohortLearned, comparator: cohortComparator, regressed });
  }
  if (cohortDiagnostics.some((entry) => entry.regressed)) reasons.push('cohort_regression');

  const hardReasons = reasons.filter((reason) => reason !== 'insufficient_labeled_predictions');
  const healthStatus = labeled.length < minimumLabels
    ? 'insufficient'
    : (hardReasons.length ? 'unhealthy' : 'healthy');

  return {
    healthStatus,
    reasons,
    labeledSampleCount: labeled.length,
    learnedMetrics,
    legacyMetrics,
    comparatorMetrics,
    driftMetrics: {
      psi,
      positiveRateDelta,
      probabilityHistogram: histogram,
      referenceSampleCount: Number(reference?.sampleCount ?? 0),
      cohortDiagnostics,
    },
  };
}

function deploymentSnapshot(row) {
  if (!row) return {};
  return {
    predictionModelID: row.prediction_model_id ?? null,
    fallbackPredictionModelID: row.fallback_prediction_model_id ?? null,
    challengerPredictionModelID: row.challenger_prediction_model_id ?? null,
    deploymentMode: row.deployment_mode ?? 'disabled',
    rolloutPercent: Number(row.rollout_percent ?? 0),
    stageStartedAt: row.stage_started_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

async function loadDeploymentState(client) {
  const result = await client.query(
    `SELECT * FROM prediction_model_deployments WHERE deployment_key=$1`,
    [DEPLOYMENT_KEY],
  );
  return result.rows?.[0] ?? null;
}

async function loadModel(client, modelID) {
  if (!modelID) return null;
  const result = await client.query(
    `SELECT prediction_model_id,model_version,model_status,training_metrics,
            baseline_metrics,safety_gate_result,trained_at
       FROM prediction_models
      WHERE prediction_model_id=$1 AND model_name=$2`,
    [modelID, MODEL_NAME],
  );
  return result.rows?.[0] ?? null;
}

async function latestModel(client) {
  const result = await client.query(
    `SELECT prediction_model_id,model_version,model_status,training_metrics,
            baseline_metrics,safety_gate_result,trained_at
       FROM prediction_models
      WHERE model_name=$1
      ORDER BY model_version DESC
      LIMIT 1`,
    [MODEL_NAME],
  );
  return result.rows?.[0] ?? null;
}

async function trainingFreshness(client, latest) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS total_examples,
            COUNT(*) FILTER (WHERE observed_at > COALESCE($1::timestamptz,'epoch'::timestamptz))::int AS new_examples,
            MAX(observed_at) AS latest_observed_at
       FROM learning_completion_examples_v1`,
    [latest?.trained_at ?? null],
  );
  return result.rows?.[0] ?? { total_examples: 0, new_examples: 0, latest_observed_at: null };
}

function trainingDue(latest, freshness, now, config) {
  const total = Number(freshness.total_examples ?? 0);
  const added = Number(freshness.new_examples ?? total);
  if (total < config.minimumTrainingExamples) return { due: false, reason: 'insufficient_training_examples' };
  if (!latest) return { due: true, reason: 'first_model' };
  if (added <= 0) return { due: false, reason: 'no_new_labels' };
  const ageHours = Math.max(0, (now.getTime() - new Date(latest.trained_at).getTime()) / 3_600_000);
  if (added >= config.retrainMinimumNewLabels && ageHours >= config.retrainMinimumIntervalHours) {
    return { due: true, reason: 'new_label_threshold' };
  }
  if (ageHours >= config.retrainMaximumIntervalHours) return { due: true, reason: 'maximum_retrain_age' };
  return { due: false, reason: 'retrain_not_due' };
}

async function evaluationRows(client, modelID, since, limit) {
  const result = await client.query(
    `SELECT final_probability,legacy_probability,comparator_probability,comparator_prediction_model_id,
            cohort_key,prediction_level,actual_status,observed_at,scored_at
       FROM prediction_shadow_evaluation_v1
      WHERE prediction_model_id=$1
        AND actual_status IS NOT NULL
        AND ($2::timestamptz IS NULL OR scored_at >= $2::timestamptz)
      ORDER BY observed_at DESC
      LIMIT $3`,
    [modelID, since ?? null, Math.max(1, Math.min(50_000, Number(limit) || 10_000))],
  );
  return result.rows ?? [];
}

async function persistHealthSnapshot(client, modelID, deployment, health, rows, { newEvidence = true } = {}) {
  const times = rows.map((row) => new Date(row.scored_at ?? row.observed_at).getTime()).filter(Number.isFinite);
  const windowStart = times.length ? new Date(Math.min(...times)).toISOString() : null;
  const windowEnd = times.length ? new Date(Math.max(...times)).toISOString() : null;
  const inserted = await client.query(
    `INSERT INTO prediction_model_health_snapshots(
       prediction_model_id,deployment_mode,rollout_percent,window_start,window_end,
       labeled_sample_count,learned_metrics,legacy_metrics,comparator_metrics,drift_metrics,health_status,health_reasons
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb)
     RETURNING prediction_model_health_snapshot_id`,
    [
      modelID,
      deployment.deployment_mode,
      Number(deployment.rollout_percent ?? 0),
      windowStart,
      windowEnd,
      health.labeledSampleCount,
      JSON.stringify(health.learnedMetrics),
      JSON.stringify(health.legacyMetrics),
      JSON.stringify(health.comparatorMetrics),
      JSON.stringify(health.driftMetrics),
      health.healthStatus,
      JSON.stringify(health.reasons),
    ],
  );
  await client.query(
    `UPDATE prediction_model_deployments
        SET last_health_checked_at=NOW(),
            consecutive_healthy_checks=CASE
              WHEN $2='unhealthy' THEN 0
              WHEN $2='healthy' AND $3=TRUE THEN consecutive_healthy_checks+1
              ELSE consecutive_healthy_checks
            END
      WHERE deployment_key=$1`,
    [DEPLOYMENT_KEY, health.healthStatus, newEvidence],
  );
  return inserted.rows?.[0]?.prediction_model_health_snapshot_id ?? null;
}

async function openAlert(client, modelID, alertType, severity, details) {
  const key = `${MODEL_NAME}:${modelID ?? 'none'}:${alertType}`;
  await client.query(
    `INSERT INTO prediction_model_alerts(
       prediction_model_id,alert_type,severity,alert_status,alert_key,details,detected_at
     ) VALUES ($1,$2,$3,'open',$4,$5::jsonb,NOW())
     ON CONFLICT(alert_key) WHERE alert_status='open' DO UPDATE SET
       severity=EXCLUDED.severity,
       details=EXCLUDED.details,
       detected_at=NOW()`,
    [modelID ?? null, alertType, severity, key, JSON.stringify(details ?? {})],
  );
}

async function resolveAlerts(client, modelID) {
  await client.query(
    `UPDATE prediction_model_alerts
        SET alert_status='resolved',resolved_at=NOW()
      WHERE prediction_model_id=$1 AND alert_status='open'`,
    [modelID],
  );
}

async function startOpsRun(client, type, modelID, reason, deployment, metadata = {}) {
  const result = await client.query(
    `INSERT INTO prediction_model_ops_runs(
       operation_type,operation_status,prediction_model_id,trigger_reason,deployment_before,metadata
     ) VALUES ($1,'running',$2,$3,$4::jsonb,$5::jsonb)
     RETURNING prediction_model_ops_run_id`,
    [type, modelID ?? null, reason ?? null, JSON.stringify(deploymentSnapshot(deployment)), JSON.stringify(metadata)],
  );
  return result.rows?.[0]?.prediction_model_ops_run_id ?? null;
}

async function finishOpsRun(client, runID, status, deployment, metrics = {}, error = null) {
  if (!runID) return;
  await client.query(
    `UPDATE prediction_model_ops_runs
        SET operation_status=$2,finished_at=NOW(),deployment_after=$3::jsonb,metrics=$4::jsonb,
            error_code=$5,error_message=$6
      WHERE prediction_model_ops_run_id=$1`,
    [
      runID,
      status,
      JSON.stringify(deploymentSnapshot(deployment)),
      JSON.stringify(metrics ?? {}),
      error?.code ?? null,
      error?.message ? String(error.message).slice(0, 1000) : null,
    ],
  );
}

async function setShadowChallenger(client, deployment, challengerID, metadata = {}) {
  if (deployment?.deployment_mode === 'active' && deployment.prediction_model_id) {
    await client.query(
      `UPDATE prediction_model_deployments
          SET challenger_prediction_model_id=$2,
              automation_managed=TRUE,
              stage_started_at=NOW(),
              consecutive_healthy_checks=0,
              last_health_checked_at=NULL,
              deployment_metadata=deployment_metadata || $3::jsonb,
              updated_at=NOW()
        WHERE deployment_key=$1`,
      [DEPLOYMENT_KEY, challengerID, JSON.stringify(metadata)],
    );
    await client.query(
      `UPDATE prediction_models SET model_status='shadow' WHERE prediction_model_id=$1`,
      [challengerID],
    );
    await client.query(
      `INSERT INTO prediction_model_deployment_history(
         deployment_key,from_prediction_model_id,to_prediction_model_id,
         fallback_prediction_model_id,challenger_prediction_model_id,
         from_mode,to_mode,from_rollout_percent,to_rollout_percent,
         change_reason,automated,metadata,occurred_at
       ) VALUES ($1,$2,$2,$3,$4,'active','active',$5,$5,
                 'automatic_shadow_challenger_attached',TRUE,$6::jsonb,NOW())`,
      [DEPLOYMENT_KEY, deployment.prediction_model_id, deployment.fallback_prediction_model_id ?? null,
        challengerID, Number(deployment.rollout_percent ?? 100), JSON.stringify(metadata)],
    );
    return;
  }
  await promotePredictionDeployment(client, {
    modelID: challengerID,
    mode: 'shadow',
    rolloutPercent: 100,
    automated: true,
    changeReason: 'automatic_shadow_start',
    metadata,
  });
}

function nextRollout(current, steps) {
  return steps.find((step) => step > Number(current ?? 0)) ?? 100;
}

function hasNewLabeledEvidence(rows, lastCheckedAt) {
  if (!lastCheckedAt) return (rows?.length ?? 0) > 0;
  const boundary = new Date(lastCheckedAt).getTime();
  return (rows ?? []).some((row) => new Date(row.observed_at ?? row.scored_at ?? 0).getTime() > boundary);
}

async function startCanary(client, deployment, challengerID, config, health) {
  const firstRollout = config.rolloutSteps[0] ?? 10;
  if (deployment?.deployment_mode === 'active' && deployment.prediction_model_id
      && deployment.prediction_model_id !== challengerID) {
    await promotePredictionDeployment(client, {
      modelID: challengerID,
      mode: 'active',
      rolloutPercent: firstRollout,
      fallbackModelID: deployment.prediction_model_id,
      challengerModelID: null,
      automated: true,
      changeReason: 'automatic_canary_start',
      metadata: { health },
      minimumShadowLabels: 0,
      requireShadowImprovement: false,
    });
    return;
  }
  await promotePredictionDeployment(client, {
    modelID: challengerID,
    mode: 'active',
    rolloutPercent: firstRollout,
    fallbackModelID: deployment?.fallback_prediction_model_id ?? null,
    challengerModelID: null,
    automated: true,
    changeReason: 'automatic_canary_start',
    metadata: { health },
    minimumShadowLabels: 0,
    requireShadowImprovement: false,
  });
}

async function rollbackToSafety(client, deployment, health) {
  const fallback = deployment?.fallback_prediction_model_id ?? null;
  if (fallback) {
    await promotePredictionDeployment(client, {
      modelID: fallback,
      mode: 'active',
      rolloutPercent: 100,
      fallbackModelID: null,
      challengerModelID: null,
      automated: true,
      changeReason: 'automatic_health_rollback_to_fallback',
      metadata: { health },
    });
    if (deployment.prediction_model_id && deployment.prediction_model_id !== fallback) {
      await client.query(
        `UPDATE prediction_models SET model_status='rejected',retired_at=NOW() WHERE prediction_model_id=$1`,
        [deployment.prediction_model_id],
      );
    }
    return 'fallback';
  }
  await promotePredictionDeployment(client, {
    modelID: deployment?.prediction_model_id ?? null,
    mode: 'shadow',
    rolloutPercent: 100,
    fallbackModelID: null,
    challengerModelID: null,
    automated: true,
    changeReason: 'automatic_health_rollback_to_shadow',
    metadata: { health },
  });
  return 'shadow';
}

export async function runPredictionModelLifecycle(client, {
  now = new Date(),
  config,
  trainingExecutor = null,
} = {}) {
  if (!config?.enabled) return { skipped: true, reason: 'model_ops_disabled' };

  const initialDeployment = await loadDeploymentState(client);
  const runID = await startOpsRun(client, 'lifecycle_tick', initialDeployment?.prediction_model_id, 'scheduled_tick', initialDeployment);
  const actions = [];
  try {
    const latest = await latestModel(client);
    const freshness = await trainingFreshness(client, latest);
    const due = trainingDue(latest, freshness, now, config);
    const lifecycleBusy = Boolean(
      initialDeployment?.challenger_prediction_model_id
      || initialDeployment?.fallback_prediction_model_id
      || initialDeployment?.deployment_mode === 'shadow'
      || (initialDeployment?.deployment_mode === 'active' && Number(initialDeployment?.rollout_percent ?? 100) < 100)
    );

    if (due.due && !lifecycleBusy) {
      try {
        const trainingOptions = {
          dataset: { limit: config.trainingLimit },
          model: {
            training: { logistic: { epochs: config.trainingEpochs } },
            gates: config.offlineGates,
            minimumIndividualSamples: config.minimumIndividualSamples,
          },
          persistence: { autoDeployShadow: false },
        };
        const trained = trainingExecutor
          ? await trainingExecutor(trainingOptions)
          : await trainAndPersistCompletionHierarchy(client, trainingOptions);
        actions.push({ type: 'trained', ...trained });
        if (trained.safetyGateResult?.passed === true) {
          const deployment = await loadDeploymentState(client);
          await setShadowChallenger(client, deployment, trained.predictionModelID, {
            automatedBy: 'phase6-model-ops',
            trainingReason: due.reason,
          });
          actions.push({ type: 'shadow_started', modelID: trained.predictionModelID });
        } else {
          await openAlert(client, trained.predictionModelID, 'offline_gate_failed', 'warning', trained.safetyGateResult);
        }
      } catch (error) {
        actions.push({ type: 'training_skipped_or_failed', message: error.message });
      }
    }

    let deployment = await loadDeploymentState(client);
    if (!deployment) {
      await finishOpsRun(client, runID, 'success', deployment, { actions, trainingFreshness: freshness });
      return { success: true, actions, deployment: null };
    }

    const candidateID = deployment.challenger_prediction_model_id
      ?? (deployment.deployment_mode === 'shadow' ? deployment.prediction_model_id : null);

    if (candidateID) {
      const candidate = await loadModel(client, candidateID);
      const reference = candidate?.training_metrics?.monitoringReference ?? {};
      const rows = await evaluationRows(client, candidateID, deployment.stage_started_at, config.evaluationLimit);
      const health = evaluatePredictionHealth(rows, reference, {
        ...config.healthGates,
        minimumLabels: config.minimumShadowLabels,
        requireLearnedImprovement: true,
        minLogLossImprovement: config.minimumShadowLogLossImprovement,
      });
      const newEvidence = hasNewLabeledEvidence(rows, deployment.last_health_checked_at);
      const projectedHealthyChecks = health.healthStatus === 'healthy' && newEvidence
        ? Number(deployment.consecutive_healthy_checks ?? 0) + 1
        : Number(deployment.consecutive_healthy_checks ?? 0);
      await persistHealthSnapshot(client, candidateID, { ...deployment, deployment_mode: 'shadow' }, health, rows, { newEvidence });
      actions.push({ type: 'shadow_health', modelID: candidateID, health, newEvidence, projectedHealthyChecks });
      if (health.healthStatus === 'healthy' && projectedHealthyChecks >= config.minimumHealthyChecks) {
        await resolveAlerts(client, candidateID);
        if (config.runtimeMode === 'active') {
          await startCanary(client, deployment, candidateID, config, health);
          actions.push({ type: 'canary_started', modelID: candidateID, rolloutPercent: config.rolloutSteps[0] });
          deployment = await loadDeploymentState(client);
        } else {
          actions.push({ type: 'awaiting_runtime_active_authorization', modelID: candidateID });
        }
      } else if (health.healthStatus === 'unhealthy') {
        await openAlert(client, candidateID, 'shadow_health_failed', 'warning', health);
      }
    }

    if (deployment.deployment_mode === 'active' && deployment.prediction_model_id) {
      const activeModel = await loadModel(client, deployment.prediction_model_id);
      const reference = activeModel?.training_metrics?.monitoringReference ?? {};
      const rows = await evaluationRows(client, deployment.prediction_model_id, deployment.stage_started_at, config.evaluationLimit);
      const health = evaluatePredictionHealth(rows, reference, {
        ...config.healthGates,
        minimumLabels: config.minimumCanaryLabels,
        requireLearnedImprovement: false,
      });
      const newEvidence = hasNewLabeledEvidence(rows, deployment.last_health_checked_at);
      const projectedHealthyChecks = health.healthStatus === 'healthy' && newEvidence
        ? Number(deployment.consecutive_healthy_checks ?? 0) + 1
        : Number(deployment.consecutive_healthy_checks ?? 0);
      await persistHealthSnapshot(client, deployment.prediction_model_id, deployment, health, rows, { newEvidence });
      actions.push({ type: 'active_health', modelID: deployment.prediction_model_id, rolloutPercent: deployment.rollout_percent, health, newEvidence, projectedHealthyChecks });

      if (health.healthStatus === 'unhealthy' && config.automaticRollback) {
        await openAlert(client, deployment.prediction_model_id, 'active_health_failed', 'critical', health);
        const target = await rollbackToSafety(client, deployment, health);
        actions.push({ type: 'rolled_back', target });
        deployment = await loadDeploymentState(client);
      } else if (health.healthStatus === 'healthy' && projectedHealthyChecks >= config.minimumHealthyChecks && config.runtimeMode === 'active') {
        await resolveAlerts(client, deployment.prediction_model_id);
        const currentRollout = Number(deployment.rollout_percent ?? 0);
        if (currentRollout < 100) {
          const next = nextRollout(currentRollout, config.rolloutSteps);
          await promotePredictionDeployment(client, {
            modelID: deployment.prediction_model_id,
            mode: 'active',
            rolloutPercent: next,
            fallbackModelID: deployment.fallback_prediction_model_id ?? null,
            challengerModelID: null,
            automated: true,
            changeReason: 'automatic_canary_advance',
            metadata: { previousRolloutPercent: currentRollout, health },
          });
          actions.push({ type: 'canary_advanced', from: currentRollout, to: next });
          deployment = await loadDeploymentState(client);
        } else if (deployment.fallback_prediction_model_id) {
          const oldChampion = deployment.fallback_prediction_model_id;
          await promotePredictionDeployment(client, {
            modelID: deployment.prediction_model_id,
            mode: 'active',
            rolloutPercent: 100,
            fallbackModelID: null,
            challengerModelID: null,
            automated: true,
            changeReason: 'automatic_full_rollout',
            metadata: { health },
          });
          await client.query(
            `UPDATE prediction_models SET model_status='retired',retired_at=NOW()
              WHERE prediction_model_id=$1 AND prediction_model_id<>$2`,
            [oldChampion, deployment.prediction_model_id],
          );
          actions.push({ type: 'full_rollout_completed', retiredModelID: oldChampion });
          deployment = await loadDeploymentState(client);
        }
      }
    }

    await finishOpsRun(client, runID, 'success', deployment, { actions, trainingFreshness: freshness });
    return { success: true, actions, deployment: deploymentSnapshot(deployment) };
  } catch (error) {
    const deployment = await loadDeploymentState(client).catch(() => null);
    await finishOpsRun(client, runID, 'failed', deployment, { actions }, error).catch(() => {});
    throw error;
  }
}

export const modelOpsInternals = Object.freeze({
  DEPLOYMENT_KEY,
  MODEL_NAME,
  deploymentSnapshot,
  trainingDue,
  nextRollout,
  hasNewLabeledEvidence,
});
