const EPSILON = 1e-6;

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function probability(value) {
  return Math.max(EPSILON, Math.min(1 - EPSILON, finite(value, 0.5)));
}

export function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-Math.min(50, value));
    return 1 / (1 + z);
  }
  const z = Math.exp(Math.max(-50, value));
  return z / (1 + z);
}

export function logit(value) {
  const p = probability(value);
  return Math.log(p / (1 - p));
}

function dayPart(second) {
  const value = Math.max(0, Math.min(86_399, Math.trunc(finite(second))));
  if (value < 6 * 3600) return 'overnight';
  if (value < 12 * 3600) return 'morning';
  if (value < 17 * 3600) return 'afternoon';
  if (value < 22 * 3600) return 'evening';
  return 'lateNight';
}

function behaviorBand(rate, samples) {
  if (finite(samples) < 5) return 'new';
  const value = rate == null ? 0.5 : clamp(rate);
  if (value < 0.4) return 'low';
  if (value < 0.7) return 'medium';
  return 'high';
}

function nested(object, path, fallback = null) {
  let value = object;
  for (const key of path) {
    if (value == null || typeof value !== 'object') return fallback;
    value = value[key];
  }
  return value ?? fallback;
}

function exampleContext(example = {}) {
  return example.context_data ?? example.contextData ?? example.routingContext ?? {};
}

function exampleCandidateFeatures(example = {}) {
  return example.candidate_features ?? example.candidateFeatures ?? example.candidate ?? {};
}

function exampleProgress(example = {}) {
  return example.progress_snapshot ?? example.progressSnapshot ?? {};
}

function exampleKind(example = {}) {
  return String(example.candidate_kind ?? example.candidateKind ?? example.kind ?? 'other');
}

function exampleDecisionSecond(example = {}) {
  return finite(example.decision_second ?? example.decisionSecond, 0);
}

function behavioral(example = {}) {
  return exampleContext(example).behavioralFeatures ?? example.behavioralFeatures ?? {};
}

function completionRate(stats, fallback = 0.65) {
  const value = stats?.completionRate;
  return value == null ? fallback : clamp(value);
}

function averageCompletionScore(stats, fallback = 0.65) {
  const value = stats?.averageCompletionScore;
  return value == null ? fallback : clamp(value);
}

function sampleCount(stats) {
  return Math.max(0, finite(stats?.sampleCount, 0));
}

export function completionLabel(example = {}) {
  if (example.label != null) return clamp(example.label);
  return String(example.actual_status ?? example.actualStatus ?? '').toLowerCase() === 'completed' ? 1 : 0;
}

export function buildCompletionFeatureMap(example = {}) {
  const features = exampleCandidateFeatures(example);
  const context = exampleContext(example);
  const progress = exampleProgress(example);
  const behavior = behavioral(example);
  const allTime = behavior.allTime ?? {};
  const seven = behavior.trailing7Days ?? {};
  const thirty = behavior.trailing30Days ?? {};
  const kind = exampleKind(example);
  const decisionSecond = exampleDecisionSecond(example);
  const part = dayPart(features.fixedStartSecond ?? features.earliestStartSecond ?? decisionSecond);
  const byKind = behavior.byKind?.[kind] ?? {};
  const byTime = behavior.byTimeBucket?.[part] ?? {};
  const startSecond = finite(features.fixedStartSecond ?? features.earliestStartSecond ?? decisionSecond, decisionSecond);
  const latestEndSecond = finite(features.latestEndSecond, startSecond + finite(features.durationSeconds, 0));
  const flexibility = Math.max(0, latestEndSecond - startSecond - finite(features.durationSeconds, 0));

  const result = {
    durationHours: finite(features.durationSeconds, 0) / 3600,
    decisionDayFraction: decisionSecond / 86_400,
    startDayFraction: startSecond / 86_400,
    flexibilityHours: flexibility / 3600,
    candidateRank: finite(example.candidate_rank ?? example.candidateRank, 0) / 10,
    progressWeight: finite(features.progressWeightHint ?? example.predicted_progress_points, 0) / 100,
    goalImpact: clamp(features.goalImpact ?? 0.5),
    priority: clamp(features.priority ?? 0.5),
    urgency: clamp(features.urgency ?? 0.5),
    preferenceFit: clamp(features.preferenceFit ?? 0.5),
    contextFit: clamp(features.contextFit ?? 0.5),
    momentumFit: clamp(features.momentumFit ?? 0.5),
    effortCost: clamp(features.effortCost ?? 0.25),
    fatigueCost: clamp(features.fatigueCost ?? 0.25),
    transitionCost: clamp(features.transitionCost ?? 0),
    allTimeCompletionRate: completionRate(allTime),
    allTimeAverageScore: averageCompletionScore(allTime),
    allTimeSampleLog: Math.log1p(sampleCount(allTime)) / 6,
    sevenDayCompletionRate: completionRate(seven),
    sevenDaySampleLog: Math.log1p(sampleCount(seven)) / 5,
    thirtyDayCompletionRate: completionRate(thirty),
    kindCompletionRate: completionRate(byKind),
    kindSampleLog: Math.log1p(sampleCount(byKind)) / 5,
    timeCompletionRate: completionRate(byTime),
    timeSampleLog: Math.log1p(sampleCount(byTime)) / 5,
    dayProgress: clamp(progress.dayProgress ?? 0),
    expectedDayFinish: clamp(progress.expectedDayFinish ?? progress.dayProgress ?? 0),
    required: features.required === true ? 1 : 0,
    hardExcluded: features.hardExcluded === true ? 1 : 0,
    [`kind:${kind}`]: 1,
    [`daypart:${part}`]: 1,
    [`decision:${String(example.decision_type ?? example.decisionType ?? 'unknown')}`]: 1,
    [`reroute:${String(example.reroute_reason ?? example.rerouteReason ?? 'none')}`]: 1,
    [`progressCategory:${String(features.progressCategory ?? 'other')}`]: 1,
  };
  if (context.mode != null) result[`contextMode:${String(context.mode)}`] = 1;
  return result;
}

export function cohortKeyForExample(example = {}) {
  const kind = exampleKind(example);
  const features = exampleCandidateFeatures(example);
  const behavior = behavioral(example);
  const allTime = behavior.allTime ?? {};
  const second = features.fixedStartSecond ?? features.earliestStartSecond ?? exampleDecisionSecond(example);
  return [
    `kind=${kind}`,
    `daypart=${dayPart(second)}`,
    `behavior=${behaviorBand(allTime.completionRate, allTime.sampleCount)}`,
  ].join('|');
}

function featureNamesFromExamples(examples) {
  const names = new Set();
  for (const example of examples) {
    for (const name of Object.keys(buildCompletionFeatureMap(example))) names.add(name);
  }
  return [...names].sort();
}

function rawVector(example, featureNames) {
  const map = buildCompletionFeatureMap(example);
  return featureNames.map((name) => finite(map[name], 0));
}

function standardizer(examples, featureNames) {
  const vectors = examples.map((example) => rawVector(example, featureNames));
  const means = featureNames.map((_, column) => (
    vectors.reduce((sum, vector) => sum + vector[column], 0) / Math.max(1, vectors.length)
  ));
  const scales = featureNames.map((_, column) => {
    const mean = means[column];
    const variance = vectors.reduce((sum, vector) => {
      const delta = vector[column] - mean;
      return sum + delta * delta;
    }, 0) / Math.max(1, vectors.length);
    const scale = Math.sqrt(variance);
    return scale > 1e-8 ? scale : 1;
  });
  return { means, scales };
}

function standardizedVector(example, artifact) {
  const vector = rawVector(example, artifact.featureNames);
  return vector.map((value, index) => (value - artifact.means[index]) / artifact.scales[index]);
}

export function trainPopulationCompletionModel(examples, {
  epochs = 900,
  learningRate = 0.05,
  l2 = 0.002,
} = {}) {
  if (!Array.isArray(examples) || examples.length < 2) {
    throw new TypeError('At least two completion examples are required to train the population model.');
  }
  const featureNames = featureNamesFromExamples(examples);
  const { means, scales } = standardizer(examples, featureNames);
  const artifact = {
    family: 'logistic-regression',
    featureContract: 'completion-v1',
    featureNames,
    means,
    scales,
    weights: new Array(featureNames.length).fill(0),
    intercept: logit(examples.reduce((sum, example) => sum + completionLabel(example), 0) / examples.length),
  };
  const labels = examples.map(completionLabel);
  const vectors = examples.map((example) => standardizedVector(example, artifact));
  const count = examples.length;

  for (let epoch = 0; epoch < Math.max(1, Math.trunc(epochs)); epoch += 1) {
    let interceptGradient = 0;
    const gradients = new Array(featureNames.length).fill(0);
    for (let row = 0; row < count; row += 1) {
      let z = artifact.intercept;
      for (let column = 0; column < artifact.weights.length; column += 1) {
        z += artifact.weights[column] * vectors[row][column];
      }
      const error = sigmoid(z) - labels[row];
      interceptGradient += error;
      for (let column = 0; column < gradients.length; column += 1) {
        gradients[column] += error * vectors[row][column];
      }
    }
    artifact.intercept -= learningRate * (interceptGradient / count);
    for (let column = 0; column < artifact.weights.length; column += 1) {
      const gradient = (gradients[column] / count) + l2 * artifact.weights[column];
      artifact.weights[column] -= learningRate * gradient;
    }
  }
  artifact.training = { epochs, learningRate, l2, exampleCount: examples.length };
  return artifact;
}

export function predictPopulationCompletion(artifact, example) {
  if (!artifact?.featureNames || !artifact?.weights) return 0.65;
  const vector = standardizedVector(example, artifact);
  let z = finite(artifact.intercept, 0);
  for (let index = 0; index < artifact.weights.length; index += 1) {
    z += finite(artifact.weights[index]) * vector[index];
  }
  return probability(sigmoid(z));
}

export function fitPlattCalibration(probabilities, labels, {
  epochs = 400,
  learningRate = 0.04,
  l2 = 0.001,
} = {}) {
  if (!Array.isArray(probabilities) || probabilities.length < 10 || probabilities.length !== labels.length) {
    return { type: 'identity', a: 1, b: 0, sampleCount: probabilities?.length ?? 0 };
  }
  const unique = new Set(labels.map((value) => (value >= 0.5 ? 1 : 0)));
  if (unique.size < 2) return { type: 'identity', a: 1, b: 0, sampleCount: probabilities.length };
  let a = 1;
  let b = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let ga = 0;
    let gb = 0;
    for (let index = 0; index < probabilities.length; index += 1) {
      const x = logit(probabilities[index]);
      const p = sigmoid(a * x + b);
      const error = p - labels[index];
      ga += error * x;
      gb += error;
    }
    a -= learningRate * ((ga / probabilities.length) + l2 * (a - 1));
    b -= learningRate * (gb / probabilities.length);
  }
  return { type: 'platt', a, b, sampleCount: probabilities.length };
}

export function applyCalibration(calibration, rawProbability) {
  const p = probability(rawProbability);
  if (!calibration || calibration.type === 'identity') return p;
  return probability(sigmoid(finite(calibration.a, 1) * logit(p) + finite(calibration.b, 0)));
}

export function temporalSplit(examples, {
  trainFraction = 0.70,
  validationFraction = 0.15,
} = {}) {
  const sorted = [...examples].sort((left, right) => (
    new Date(left.decision_at ?? left.decisionAt ?? 0).getTime()
      - new Date(right.decision_at ?? right.decisionAt ?? 0).getTime()
  ));
  if (sorted.length < 3) return { train: sorted, validation: [], test: [] };
  const trainEnd = Math.max(1, Math.min(sorted.length - 2, Math.floor(sorted.length * trainFraction)));
  const validationEnd = Math.max(
    trainEnd + 1,
    Math.min(sorted.length - 1, Math.floor(sorted.length * (trainFraction + validationFraction))),
  );
  return {
    train: sorted.slice(0, trainEnd),
    validation: sorted.slice(trainEnd, validationEnd),
    test: sorted.slice(validationEnd),
  };
}

export function predictionMetrics(probabilities, labels, { bins = 10 } = {}) {
  const count = probabilities.length;
  if (!count) {
    return { sampleCount: 0, positiveRate: null, logLoss: null, brier: null, auc: null, ece: null };
  }
  let logLoss = 0;
  let brier = 0;
  let positives = 0;
  for (let index = 0; index < count; index += 1) {
    const p = probability(probabilities[index]);
    const y = labels[index] >= 0.5 ? 1 : 0;
    positives += y;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    brier += (p - y) ** 2;
  }

  const ranked = probabilities.map((p, index) => ({ p: finite(p), y: labels[index] >= 0.5 ? 1 : 0 }))
    .sort((a, b) => a.p - b.p);
  const positiveCount = ranked.reduce((sum, row) => sum + row.y, 0);
  const negativeCount = ranked.length - positiveCount;
  let auc = null;
  if (positiveCount && negativeCount) {
    let rankSum = 0;
    let index = 0;
    while (index < ranked.length) {
      let end = index + 1;
      while (end < ranked.length && ranked[end].p === ranked[index].p) end += 1;
      const averageRank = ((index + 1) + end) / 2;
      for (let cursor = index; cursor < end; cursor += 1) {
        if (ranked[cursor].y) rankSum += averageRank;
      }
      index = end;
    }
    auc = (rankSum - (positiveCount * (positiveCount + 1)) / 2) / (positiveCount * negativeCount);
  }

  let ece = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const low = bin / bins;
    const high = (bin + 1) / bins;
    const rows = probabilities.map((p, index) => ({ p: probability(p), y: labels[index] >= 0.5 ? 1 : 0 }))
      .filter((row) => row.p >= low && (bin === bins - 1 ? row.p <= high : row.p < high));
    if (!rows.length) continue;
    const confidence = rows.reduce((sum, row) => sum + row.p, 0) / rows.length;
    const accuracy = rows.reduce((sum, row) => sum + row.y, 0) / rows.length;
    ece += (rows.length / count) * Math.abs(confidence - accuracy);
  }

  return {
    sampleCount: count,
    positiveRate: positives / count,
    logLoss: logLoss / count,
    brier: brier / count,
    auc,
    ece,
  };
}

export function fitResidualCalibrations(examples, populationProbabilities, {
  keyForExample,
  priorStrength = 20,
  shrinkageHalfLife = 40,
  minimumSamples = 1,
} = {}) {
  const groups = new Map();
  for (let index = 0; index < examples.length; index += 1) {
    const key = String(keyForExample(examples[index]));
    const record = groups.get(key) ?? { key, sampleCount: 0, positiveCount: 0, predictionSum: 0 };
    record.sampleCount += 1;
    record.positiveCount += completionLabel(examples[index]) >= 0.5 ? 1 : 0;
    record.predictionSum += probability(populationProbabilities[index]);
    groups.set(key, record);
  }
  const result = [];
  for (const record of groups.values()) {
    if (record.sampleCount < minimumSamples) continue;
    const meanPrediction = record.predictionSum / record.sampleCount;
    const priorSuccesses = meanPrediction * priorStrength;
    const smoothedRate = (record.positiveCount + priorSuccesses) / (record.sampleCount + priorStrength);
    const rawOffset = logit(smoothedRate) - logit(meanPrediction);
    const shrinkageWeight = record.sampleCount / (record.sampleCount + Math.max(1, shrinkageHalfLife));
    result.push({
      key: record.key,
      sampleCount: record.sampleCount,
      positiveCount: record.positiveCount,
      rawRate: record.positiveCount / record.sampleCount,
      meanPopulationPrediction: meanPrediction,
      rawLogitOffset: rawOffset,
      logitOffset: rawOffset * shrinkageWeight,
      shrinkageWeight,
    });
  }
  return result;
}

export function applyHierarchy({
  populationProbability,
  cohort = null,
  individual = null,
} = {}) {
  const population = probability(populationProbability);
  const cohortOffset = finite(cohort?.logitOffset, 0);
  const individualOffset = finite(individual?.logitOffset, 0);
  const cohortProbability = probability(sigmoid(logit(population) + cohortOffset));
  const personalizedProbability = probability(sigmoid(logit(population) + cohortOffset + individualOffset));
  return {
    populationProbability: population,
    cohortProbability,
    personalizedProbability,
    finalProbability: individual ? personalizedProbability : (cohort ? cohortProbability : population),
    predictionLevel: individual ? 'personalized' : (cohort ? 'cohort' : 'population'),
  };
}

export function modelSafetyGates(metrics, baselineMetrics, {
  minTestExamples = 50,
  maxLogLoss = 0.75,
  maxBrier = 0.25,
  maxECE = 0.15,
  minAUC = 0.55,
  requireBaselineImprovement = true,
} = {}) {
  const reasons = [];
  if (finite(metrics?.sampleCount) < minTestExamples) reasons.push('insufficient_test_examples');
  if (metrics?.logLoss == null || metrics.logLoss > maxLogLoss) reasons.push('log_loss_gate_failed');
  if (metrics?.brier == null || metrics.brier > maxBrier) reasons.push('brier_gate_failed');
  if (metrics?.ece == null || metrics.ece > maxECE) reasons.push('calibration_gate_failed');
  if (metrics?.auc == null || metrics.auc < minAUC) reasons.push('auc_gate_failed');
  if (requireBaselineImprovement && baselineMetrics?.logLoss != null && metrics?.logLoss != null
      && metrics.logLoss >= baselineMetrics.logLoss) {
    reasons.push('no_log_loss_improvement_over_baseline');
  }
  return { passed: reasons.length === 0, reasons };
}

export const completionModelInternals = Object.freeze({
  dayPart,
  behaviorBand,
  rawVector,
  standardizedVector,
  probability,
});
