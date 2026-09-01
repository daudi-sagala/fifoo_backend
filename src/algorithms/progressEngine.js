import { randomUUID } from 'node:crypto';

export const DAILY_PROGRESS_POINTS = 100;

export const DEFAULT_CATEGORY_BUDGETS = Object.freeze({
  nutrition: 35,
  exercise: 25,
  movement: 10,
  recovery: 15,
  habits: 10,
  other: 5,
});

const NON_PENALIZING_STATUSES = new Set(['superseded', 'cancelledByConstraint']);
const TERMINAL_STATUSES = new Set([
  'completed',
  'partiallyCompleted',
  'skipped',
  'superseded',
  'cancelledByConstraint',
]);

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function roundPoints(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value ?? 0), 0);
}

function normalizeCategoryBudgets(intervals, requested) {
  const configured = { ...DEFAULT_CATEGORY_BUDGETS, ...(requested ?? {}) };
  const activeCategories = [...new Set(
    intervals
      .filter((interval) => Number(interval.progressWeightHint ?? 0) > 0)
      .map((interval) => String(interval.progressCategory ?? 'other')),
  )];
  if (!activeCategories.length) return {};

  const weights = Object.fromEntries(activeCategories.map((category) => [
    category,
    Math.max(0, Number(configured[category] ?? configured.other ?? 1)),
  ]));
  let denominator = sum(Object.values(weights));
  if (denominator <= 0) {
    for (const category of activeCategories) weights[category] = 1;
    denominator = activeCategories.length;
  }
  return Object.fromEntries(activeCategories.map((category) => [
    category,
    DAILY_PROGRESS_POINTS * (weights[category] / denominator),
  ]));
}

function allocateWithinCategory(intervals, budget, { maxFastingPoints }) {
  const weights = intervals.map((interval) => Math.max(0, Number(interval.progressWeightHint ?? 0)));
  const denominator = sum(weights);
  if (denominator <= 0) return intervals.map(() => 0);

  const allocations = weights.map((weight) => budget * (weight / denominator));
  let reclaimed = 0;
  const recipients = [];
  for (let index = 0; index < intervals.length; index += 1) {
    if (intervals[index].intervalKind === 'fasting' && allocations[index] > maxFastingPoints) {
      reclaimed += allocations[index] - maxFastingPoints;
      allocations[index] = maxFastingPoints;
    } else if (intervals[index].intervalKind !== 'fasting' && weights[index] > 0) {
      recipients.push(index);
    }
  }

  if (reclaimed > 0 && recipients.length) {
    const recipientWeight = sum(recipients.map((index) => weights[index]));
    for (const index of recipients) {
      allocations[index] += reclaimed * (weights[index] / recipientWeight);
    }
    reclaimed = 0;
  }

  // A category containing only fasting intervals remains capped on purpose;
  // the unused amount is redistributed globally by allocateDailyBudget.
  return allocations.map(roundPoints);
}

/**
 * Allocates exactly 100 achievement points by health category and relative
 * node value. Duration is deliberately not used as an allocation multiplier.
 */
export function allocateDailyBudget(pathOrIntervals, {
  categoryBudgets = DEFAULT_CATEGORY_BUDGETS,
  maxFastingPoints = 4,
} = {}) {
  const source = Array.isArray(pathOrIntervals)
    ? pathOrIntervals
    : pathOrIntervals?.intervals;
  if (!Array.isArray(source) || !source.length) {
    throw new TypeError('A non-empty interval collection is required.');
  }

  const intervals = source.map((interval) => ({ ...interval }));
  const budgets = normalizeCategoryBudgets(intervals, categoryBudgets);
  const byCategory = new Map();
  intervals.forEach((interval, index) => {
    const category = String(interval.progressCategory ?? 'other');
    const list = byCategory.get(category) ?? [];
    list.push({ interval, index });
    byCategory.set(category, list);
  });

  const points = intervals.map(() => 0);
  for (const [category, entries] of byCategory) {
    const allocated = allocateWithinCategory(
      entries.map((entry) => entry.interval),
      Number(budgets[category] ?? 0),
      { maxFastingPoints: Math.max(0, Number(maxFastingPoints) || 0) },
    );
    entries.forEach((entry, index) => { points[entry.index] = allocated[index]; });
  }

  let unallocated = DAILY_PROGRESS_POINTS - sum(points);
  const recipients = intervals
    .map((interval, index) => ({ interval, index }))
    .filter(({ interval }) => Number(interval.progressWeightHint ?? 0) > 0 && interval.intervalKind !== 'fasting');
  if (Math.abs(unallocated) > 0.000001 && recipients.length) {
    const denominator = sum(recipients.map(({ interval }) => interval.progressWeightHint));
    for (const { interval, index } of recipients) {
      points[index] += unallocated * (Number(interval.progressWeightHint) / denominator);
    }
  }

  const rounded = points.map(roundPoints);
  const residual = roundPoints(DAILY_PROGRESS_POINTS - sum(rounded));
  const residualIndex = [...intervals.keys()].reverse().find((index) => rounded[index] > 0) ?? intervals.length - 1;
  rounded[residualIndex] = roundPoints(rounded[residualIndex] + residual);

  let cumulative = 0;
  return intervals.map((interval, index) => {
    const plannedProgressStart = roundPoints(cumulative);
    const potentialPoints = rounded[index];
    cumulative += potentialPoints;
    return {
      ...interval,
      potentialPoints,
      plannedProgressStart,
      plannedProgressEnd: roundPoints(cumulative),
    };
  });
}

function durationScore(evaluator, actual) {
  if (actual.completed === true && actual.completedSeconds == null && actual.durationSeconds == null) return 1;
  if (actual.status === 'completed' && actual.completedSeconds == null && actual.durationSeconds == null) return 1;
  const planned = Math.max(1, Number(
    evaluator.plannedSeconds
      ?? actual.plannedSeconds
      ?? 0,
  ));
  return clamp(Number(actual.completedSeconds ?? actual.durationSeconds ?? 0) / planned);
}

function quantityScore(evaluator, actual) {
  if (actual.completed === true && actual.value == null && actual.quantity == null) return 1;
  if (actual.status === 'completed' && actual.value == null && actual.quantity == null) return 1;
  const target = Math.max(1, Number(evaluator.target ?? actual.target ?? 0));
  return clamp(Number(actual.value ?? actual.quantity ?? 0) / target);
}

function rangeScore(evaluator, actual) {
  const value = Number(actual.value);
  const minimum = Number(evaluator.minimum);
  const maximum = Number(evaluator.maximum);
  if (![value, minimum, maximum].every(Number.isFinite) || maximum < minimum) return 0;
  if (value >= minimum && value <= maximum) return 1;
  const tolerance = Math.max(1, Number(evaluator.tolerance ?? (maximum - minimum) ?? 1));
  return clamp(1 - (value < minimum ? minimum - value : value - maximum) / tolerance);
}

function weightedComposite(components, weights) {
  const entries = Object.entries(weights ?? {});
  const denominator = sum(entries.map(([, weight]) => Math.max(0, Number(weight))));
  if (denominator <= 0) return 0;
  return clamp(sum(entries.map(([key, weight]) => (
    clamp(components?.[key]) * Math.max(0, Number(weight))
  ))) / denominator);
}

function fastingScore(interval, evaluator, actual, nowSecond) {
  const plannedStart = Number(evaluator.plannedStartSecond ?? interval.startSecond);
  const plannedEnd = Number(evaluator.plannedEndSecond ?? interval.endSecond);
  const plannedSeconds = Math.max(1, plannedEnd - plannedStart);
  if (actual.brokeFastAtSecond != null) {
    return clamp((Number(actual.brokeFastAtSecond) - plannedStart) / plannedSeconds);
  }
  if (actual.fastedSeconds != null) return clamp(Number(actual.fastedSeconds) / plannedSeconds);
  return clamp((Math.min(Number(nowSecond), plannedEnd) - plannedStart) / plannedSeconds);
}

export function evaluateCompletion(interval, actual = {}, { nowSecond = DAY_END_FALLBACK } = {}) {
  const evaluator = interval.completionEvaluator ?? { type: 'binary' };
  const type = String(evaluator.type ?? 'binary');
  switch (type) {
    case 'binary': return actual.completed === true || actual.status === 'completed' ? 1 : 0;
    case 'presence': return actual.present === true || actual.completed === true ? 1 : 0;
    case 'duration': return durationScore(evaluator, actual);
    case 'quantity': return quantityScore(evaluator, actual);
    case 'range': return rangeScore(evaluator, actual);
    case 'fasting': return fastingScore(interval, evaluator, actual, nowSecond);
    case 'mealComposite':
      if (!actual.components && (actual.completed === true || actual.status === 'completed')) return 1;
      return roundPoints(weightedComposite(actual.components, evaluator.weights ?? {
        calories: 0.35,
        protein: 0.30,
        foodQuality: 0.20,
        timing: 0.15,
      }));
    case 'composite': return roundPoints(weightedComposite(actual.components, evaluator.weights));
    default: throw new TypeError(`Unsupported completion evaluator: ${type}`);
  }
}

const DAY_END_FALLBACK = 86_400;

function inferredStatus(score, requestedStatus) {
  if (requestedStatus && TERMINAL_STATUSES.has(requestedStatus)) return requestedStatus;
  if (score >= 1) return 'completed';
  if (score > 0) return 'partiallyCompleted';
  return 'skipped';
}

export function createLedgerEntry(interval, actual = {}, {
  nowSecond = DAY_END_FALLBACK,
  observedAt = new Date().toISOString(),
  entryID = randomUUID(),
  supersedesEntryID = null,
} = {}) {
  const requestedStatus = actual.status ?? null;
  const nonPenalizing = NON_PENALIZING_STATUSES.has(requestedStatus);
  const completionScore = nonPenalizing ? 0 : evaluateCompletion(interval, actual, { nowSecond });
  const status = inferredStatus(completionScore, requestedStatus);
  const potentialPoints = Math.max(0, Number(interval.potentialPoints ?? 0));
  return {
    entryID,
    intervalID: interval.intervalID,
    potentialPoints: roundPoints(potentialPoints),
    completionScore: roundPoints(completionScore),
    earnedPoints: roundPoints(nonPenalizing ? 0 : potentialPoints * completionScore),
    status,
    reasonCode: actual.reasonCode ?? null,
    observedAt,
    supersedesEntryID,
    evidence: actual.evidence ?? {},
  };
}

function latestLedgerEntries(entries) {
  const supersededEntryIDs = new Set(entries.map((entry) => entry.supersedesEntryID).filter(Boolean));
  const result = new Map();
  for (const entry of entries) {
    if (supersededEntryIDs.has(entry.entryID)) continue;
    const previous = result.get(entry.intervalID);
    if (!previous || String(entry.observedAt) > String(previous.observedAt)) {
      result.set(entry.intervalID, entry);
    }
  }
  return result;
}

export function calculateProgressSnapshot({
  intervals,
  ledgerEntries = [],
  nowSecond = 0,
  completionProbabilities = {},
} = {}) {
  if (!Array.isArray(intervals) || !intervals.length) {
    throw new TypeError('intervals must be a non-empty array.');
  }
  const intervalIDs = new Set(intervals.map((interval) => interval.intervalID));
  const ledger = latestLedgerEntries(
    ledgerEntries.filter((entry) => intervalIDs.has(entry.intervalID)),
  );
  const plannedPoints = roundPoints(sum(intervals.map((interval) => interval.potentialPoints)));
  const earnedPoints = roundPoints(sum([...ledger.values()].map((entry) => entry.earnedPoints)));

  let expectedRemainingPoints = 0;
  let achievableRemainingPoints = 0;
  for (const interval of intervals) {
    if (ledger.has(interval.intervalID)) continue;
    const points = Number(interval.potentialPoints ?? 0);
    if (interval.endSecond <= nowSecond) continue;
    achievableRemainingPoints += points;
    const probability = clamp(
      completionProbabilities[interval.intervalID]
        ?? interval.expectedCompletionProbability
        ?? 0.65,
    );
    expectedRemainingPoints += points * probability;
  }

  const denominator = plannedPoints > 0 ? plannedPoints : DAILY_PROGRESS_POINTS;
  return {
    plannedPoints,
    earnedPoints,
    dayProgress: clamp(earnedPoints / denominator),
    achievableRemainingPoints: roundPoints(achievableRemainingPoints),
    expectedRemainingPoints: roundPoints(expectedRemainingPoints),
    expectedFinishPoints: roundPoints(Math.min(denominator, earnedPoints + expectedRemainingPoints)),
    expectedDayFinish: clamp((earnedPoints + expectedRemainingPoints) / denominator),
    finalizedIntervalCount: ledger.size,
  };
}

export const progressEngineInternals = Object.freeze({
  normalizeCategoryBudgets,
  latestLedgerEntries,
  weightedComposite,
});
