import {
  compileAlternativeBranches,
  compileContinuousDay,
  freezePathAt as freezePrimaryPath,
  splitIntervalAt,
  stitchPrimaryPaths,
  validateDayGraph,
} from './dayGraph.js';
import { allocateDailyBudget } from './progressEngine.js';

const DEFAULT_BEAM_WIDTH = 24;
const DEFAULT_ROUTE_POOL_SIZE = 12;

export const DEFAULT_ROUTING_WEIGHTS = Object.freeze({
  expectedProgress: 0.35,
  goalImpact: 0.18,
  priority: 0.12,
  urgency: 0.08,
  preference: 0.08,
  contextFit: 0.07,
  momentum: 0.05,
  scheduleFit: 0.07,
  effortCost: 0.04,
  fatigueCost: 0.04,
  transitionCost: 0.02,
});

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sampleConfidence(sampleCount, halfLife) {
  const samples = Math.max(0, finite(sampleCount));
  return samples / (samples + Math.max(1, halfLife));
}

/**
 * Cold-start hierarchy. Population is always the backstop, behaviorally
 * similar cohorts gain influence next, and the individual's observed behavior
 * dominates only when its sample confidence is high enough.
 */
export function blendCompletionProbability({
  population = 0.65,
  cohort = null,
  cohortSamples = 0,
  individual = null,
  individualSamples = 0,
} = {}) {
  const populationProbability = clamp(population);
  const cohortConfidence = cohort == null ? 0 : sampleConfidence(cohortSamples, 100);
  const individualConfidence = individual == null ? 0 : sampleConfidence(individualSamples, 20);

  const afterCohort = (populationProbability * (1 - cohortConfidence))
    + (clamp(cohort) * cohortConfidence);
  return clamp(
    (afterCohort * (1 - individualConfidence))
      + (clamp(individual) * individualConfidence),
  );
}

function predictionFor(candidate, context) {
  const key = candidate.predictionKey ?? candidate.key;
  const population = context?.populationPriors?.[key]
    ?? context?.populationPriors?.[candidate.kind]
    ?? candidate.populationCompletionProbability
    ?? 0.65;
  const cohortRecord = context?.cohortPriors?.[key]
    ?? context?.cohortPriors?.[candidate.kind]
    ?? {};
  const individualRecord = context?.individualPriors?.[key]
    ?? context?.individualPriors?.[candidate.kind]
    ?? {};
  return blendCompletionProbability({
    population,
    cohort: cohortRecord.probability,
    cohortSamples: cohortRecord.samples,
    individual: individualRecord.probability,
    individualSamples: individualRecord.samples,
  });
}

function normalizedCandidate(raw, index, context) {
  const key = String(raw.key ?? `candidate-${index}`).trim();
  if (!key) throw new TypeError(`candidates[${index}].key cannot be empty.`);
  const durationSeconds = Math.max(1, Math.trunc(finite(
    raw.durationSeconds,
    finite(raw.durationMinutes, 0) * 60,
  )));
  const earliestStartSecond = Math.max(0, Math.min(86_399, Math.trunc(finite(
    raw.earliestStartSecond,
    raw.fixedStartSecond ?? 0,
  ))));
  const latestEndSecond = Math.max(earliestStartSecond + 1, Math.min(86_400, Math.trunc(finite(
    raw.latestEndSecond,
    raw.fixedStartSecond != null ? finite(raw.fixedStartSecond) + durationSeconds : 86_400,
  ))));
  const fixedStartSecond = raw.fixedStartSecond == null
    ? null
    : Math.max(0, Math.min(86_399, Math.trunc(finite(raw.fixedStartSecond))));

  return {
    ...raw,
    key,
    candidateKey: String(raw.candidateKey ?? key),
    decisionGroup: String(raw.decisionGroup ?? key),
    durationSeconds,
    earliestStartSecond,
    latestEndSecond,
    fixedStartSecond,
    required: raw.required === true,
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
    hardExcluded: raw.hardExcluded === true || raw.declined === true,
    completionProbability: predictionFor({ ...raw, key }, context),
    progressWeightHint: Math.max(0, finite(raw.progressWeightHint ?? raw.progressWeight, 1)),
  };
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function isInsideAvailability(startSecond, endSecond, availabilityWindows) {
  if (!Array.isArray(availabilityWindows) || !availabilityWindows.length) return true;
  return availabilityWindows.some((window) => (
    startSecond >= finite(window.startSecond)
      && endSecond <= finite(window.endSecond)
  ));
}

function conflictingInterval(startSecond, endSecond, intervals) {
  return (intervals ?? []).find((interval) => overlap(
    startSecond,
    endSecond,
    finite(interval.startSecond),
    finite(interval.endSecond),
  ));
}

function placeCandidate(candidate, state, context) {
  if (candidate.hardExcluded) return null;
  if (!candidate.dependencies.every((dependency) => state.selectedKeys.has(dependency))) return null;

  const transitionSeconds = Math.max(0, Math.trunc(finite(
    candidate.transitionSeconds,
    context?.defaultTransitionSeconds ?? 0,
  )));
  let startSecond = candidate.fixedStartSecond
    ?? Math.max(candidate.earliestStartSecond, state.cursorSecond + transitionSeconds);
  const busy = [...(context?.hardBusyIntervals ?? []), ...state.scheduled];

  for (let attempts = 0; attempts < busy.length + 2; attempts += 1) {
    const endSecond = startSecond + candidate.durationSeconds;
    if (endSecond > candidate.latestEndSecond || endSecond > 86_400) return null;
    if (!isInsideAvailability(startSecond, endSecond, candidate.availabilityWindows ?? context?.availabilityWindows)) {
      return null;
    }
    const conflict = conflictingInterval(startSecond, endSecond, busy);
    if (!conflict) return { startSecond, endSecond, transitionSeconds };
    if (candidate.fixedStartSecond != null) return null;
    startSecond = Math.max(startSecond + 1, Math.trunc(finite(conflict.endSecond)));
  }
  return null;
}

function candidateScore(candidate, placement, weights) {
  const w = { ...DEFAULT_ROUTING_WEIGHTS, ...(weights ?? {}) };
  const theoreticalProgress = clamp(candidate.normalizedProgressValue ?? candidate.goalImpact ?? 0.5);
  const expectedProgress = theoreticalProgress * candidate.completionProbability;
  const scheduleSpan = Math.max(1, candidate.latestEndSecond - candidate.earliestStartSecond);
  const scheduleFit = candidate.fixedStartSecond != null
    ? 1
    : 1 - clamp((placement.startSecond - candidate.earliestStartSecond) / scheduleSpan);

  return (
    expectedProgress * w.expectedProgress
      + clamp(candidate.goalImpact ?? 0.5) * w.goalImpact
      + clamp(candidate.priority ?? 0.5) * w.priority
      + clamp(candidate.urgency ?? 0.5) * w.urgency
      + clamp(candidate.preferenceFit ?? 0.5) * w.preference
      + clamp(candidate.contextFit ?? 0.5) * w.contextFit
      + clamp(candidate.momentumFit ?? 0.5) * w.momentum
      + scheduleFit * w.scheduleFit
      - clamp(candidate.effortCost ?? 0.25) * w.effortCost
      - clamp(candidate.fatigueCost ?? 0.25) * w.fatigueCost
      - clamp(candidate.transitionCost ?? placement.transitionSeconds / 3600) * w.transitionCost
  );
}

function transitionAdjustment(previous, current) {
  if (!previous) return 0;
  const previousKind = String(previous.kind ?? previous.intervalKind ?? '');
  const currentKind = String(current.kind ?? current.intervalKind ?? '');
  if (previousKind === 'workout' && currentKind === 'workout') {
    return -0.12 * (clamp(previous.intensity ?? 0.5) + clamp(current.intensity ?? 0.5));
  }
  if (previousKind === 'workout' && currentKind === 'meal') return 0.06;
  if (previousKind === currentKind && !['task', 'meal'].includes(currentKind)) return -0.04;
  return 0;
}

function finalRouteAdjustment(state) {
  const categories = new Set(state.scheduled.map((candidate) => candidate.progressCategory));
  const kinds = new Set(state.scheduled.map((candidate) => candidate.kind));
  const coverageBonus = Math.min(0.18, categories.size * 0.03);
  const varietyBonus = Math.min(0.12, kinds.size * 0.02);
  return coverageBonus + varietyBonus;
}

function routeSignature(state) {
  return state.scheduled.map((candidate) => candidate.key).join('|');
}

function routeDistance(left, right) {
  const a = new Set(left.scheduled.map((candidate) => candidate.candidateKey));
  const b = new Set(right.scheduled.map((candidate) => candidate.candidateKey));
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const key of a) if (b.has(key)) intersection += 1;
  return 1 - (intersection / union.size);
}

function groupCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const list = groups.get(candidate.decisionGroup) ?? [];
    list.push(candidate);
    groups.set(candidate.decisionGroup, list);
  }
  return [...groups.entries()]
    .map(([groupKey, options]) => ({
      groupKey,
      options,
      required: options.some((option) => option.required),
      earliestStartSecond: Math.min(...options.map((option) => option.earliestStartSecond)),
    }))
    .sort((a, b) => a.earliestStartSecond - b.earliestStartSecond || a.groupKey.localeCompare(b.groupKey));
}

function expandGroup(state, group, context, weights) {
  const expanded = [];
  for (const candidate of group.options) {
    const placement = placeCandidate(candidate, state, context);
    if (!placement) continue;
    const scheduled = {
      ...candidate,
      startSecond: placement.startSecond,
      endSecond: placement.endSecond,
    };
    const previous = state.scheduled.at(-1) ?? null;
    expanded.push({
      cursorSecond: placement.endSecond,
      scheduled: [...state.scheduled, scheduled],
      selectedKeys: new Set([...state.selectedKeys, candidate.key]),
      skippedGroups: state.skippedGroups,
      score: state.score
        + candidateScore(candidate, placement, weights)
        + transitionAdjustment(previous, scheduled),
    });
  }
  if (!group.required) {
    expanded.push({
      ...state,
      selectedKeys: new Set(state.selectedKeys),
      skippedGroups: [...state.skippedGroups, group.groupKey],
      score: state.score - 0.015,
    });
  }
  return expanded;
}

function chooseDiverse(states, count, minimumDistance) {
  const selected = [];
  for (const state of states) {
    if (!selected.length || selected.every((existing) => routeDistance(existing, state) >= minimumDistance)) {
      selected.push(state);
      if (selected.length >= count) break;
    }
  }
  if (selected.length < count) {
    for (const state of states) {
      if (!selected.includes(state)) selected.push(state);
      if (selected.length >= count) break;
    }
  }
  return selected;
}

function trimPathStart(path, startSecond, pathKey) {
  if (startSecond === 0) return { ...path, pathKey };
  const intervals = [];
  for (const interval of path.intervals) {
    if (interval.endSecond <= startSecond) continue;
    if (interval.startSecond < startSecond) {
      const [, right] = splitIntervalAt(interval, startSecond, {
        idSeed: `${path.pathID}:future`,
      });
      intervals.push({ ...right, lifecycleStatus: 'planned' });
    } else {
      intervals.push({ ...interval, lifecycleStatus: 'planned' });
    }
  }
  return {
    ...path,
    pathKey,
    intervals,
  };
}

function compileRoute(state, index, context, categoryBudgets, {
  routeStartSecond = 0,
  totalPoints = 100,
  progressOffset = 0,
} = {}) {
  const path = compileContinuousDay({
    scheduledIntervals: state.scheduled.map((candidate) => ({
      ...candidate,
      intervalKind: candidate.intervalKind ?? candidate.kind,
      completionEvaluator: candidate.completionEvaluator ?? (
        candidate.kind === 'workout'
          ? { type: 'duration', plannedSeconds: candidate.durationSeconds }
          : { type: 'binary' }
      ),
      metadata: {
        ...(candidate.metadata ?? {}),
        completionProbability: candidate.completionProbability,
        decisionGroup: candidate.decisionGroup,
      },
    })),
    idSeed: context.idSeed ?? 'fifoo-routing',
    pathKey: index === 0 ? 'chosen' : `candidate-${index + 1}`,
    pathKind: 'chosen',
    context,
  });
  const futurePath = trimPathStart(path, routeStartSecond, path.pathKey);
  futurePath.intervals = allocateDailyBudget(futurePath.intervals, {
    categoryBudgets,
    totalPoints,
  }).map((interval) => ({
    ...interval,
    plannedProgressStart: interval.plannedProgressStart + progressOffset,
    plannedProgressEnd: interval.plannedProgressEnd + progressOffset,
  }));
  futurePath.routeScore = state.score + finalRouteAdjustment(state);
  futurePath.expectedProgress = futurePath.intervals.reduce((total, interval) => {
    const probability = interval.metadata?.completionProbability
      ?? (interval.potentialPoints > 0 ? 0.65 : 0);
    return total + interval.potentialPoints * clamp(probability);
  }, 0);
  futurePath.selectedCandidateKeys = state.scheduled.map((candidate) => candidate.key);
  futurePath.skippedDecisionGroups = state.skippedGroups;
  return futurePath;
}

/**
 * Deterministic beam-search router. It is ML-ready but does not require ML:
 * explicit onboarding/context plus population priors provide cold-start input,
 * while cohort and individual predictions are blended only as evidence grows.
 */
export function optimizeDayRoutes({
  candidates,
  context = {},
  categoryBudgets = undefined,
  weights = DEFAULT_ROUTING_WEIGHTS,
  beamWidth = DEFAULT_BEAM_WIDTH,
  routePoolSize = DEFAULT_ROUTE_POOL_SIZE,
  alternativeCount = 2,
  minimumAlternativeDistance = 0.20,
  initialCursorSecond = 0,
  totalPoints = 100,
  progressOffset = 0,
  completedPath = null,
} = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new TypeError('candidates must be a non-empty array.');
  }
  const routeStartSecond = Math.max(0, Math.min(86_399, Math.trunc(finite(initialCursorSecond))));
  const eligibleCandidates = candidates
    .map((candidate) => {
      if (candidate.fixedStartSecond != null && Number(candidate.fixedStartSecond) < routeStartSecond) {
        throw new RangeError(`Candidate ${candidate.key ?? 'unknown'} is fixed before the reroute boundary.`);
      }
      if (Number(candidate.latestEndSecond ?? 86_400) <= routeStartSecond) {
        if (candidate.required === true) {
          throw new RangeError(`Required candidate ${candidate.key ?? 'unknown'} ends before the reroute boundary.`);
        }
        return null;
      }
      return {
        ...candidate,
        earliestStartSecond: Math.max(
          routeStartSecond,
          Number(candidate.earliestStartSecond ?? candidate.fixedStartSecond ?? routeStartSecond),
        ),
      };
    })
    .filter(Boolean);
  if (!eligibleCandidates.length) {
    throw new RangeError('No candidate remains after the reroute boundary.');
  }
  const normalized = eligibleCandidates.map((candidate, index) => normalizedCandidate(candidate, index, context));
  const groups = groupCandidates(normalized);
  let beam = [{
    cursorSecond: routeStartSecond,
    scheduled: [],
    selectedKeys: new Set(),
    skippedGroups: [],
    score: 0,
  }];

  for (const group of groups) {
    const expanded = beam.flatMap((state) => expandGroup(state, group, context, weights));
    if (!expanded.length) {
      throw new RangeError(`No feasible route satisfies decision group ${group.groupKey}.`);
    }
    const unique = new Map();
    for (const state of expanded.sort((a, b) => b.score - a.score)) {
      const signature = routeSignature(state);
      if (!unique.has(signature)) unique.set(signature, state);
    }
    beam = [...unique.values()].slice(0, Math.max(1, Math.trunc(beamWidth)));
  }

  const ranked = beam
    .map((state) => ({ ...state, score: state.score + finalRouteAdjustment(state) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.trunc(routePoolSize)));
  const diverse = chooseDiverse(
    ranked,
    Math.max(1, Math.trunc(alternativeCount) + 1),
    clamp(minimumAlternativeDistance),
  );
  const suffixPaths = diverse.map((state, index) => compileRoute(
    state,
    index,
    context,
    categoryBudgets,
    { routeStartSecond, totalPoints, progressOffset },
  ));
  const chosenPath = suffixPaths[0];
  const branchPrimaryPath = completedPath
    ? stitchPrimaryPaths(completedPath, chosenPath, {
        idSeed: context.idSeed ?? 'fifoo-routing',
        pathKey: 'chosen-full',
      })
    : chosenPath;

  const validAlternativePaths = [];
  const branches = [];
  for (const alternative of suffixPaths.slice(1)) {
    try {
      const comparableAlternative = completedPath
        ? stitchPrimaryPaths(completedPath, alternative, {
            idSeed: context.idSeed ?? 'fifoo-routing',
            pathKey: `${alternative.pathKey}-full`,
          })
        : alternative;
      const [branch] = compileAlternativeBranches(branchPrimaryPath, [comparableAlternative], {
        idSeed: context.idSeed ?? 'fifoo-routing',
      });
      validAlternativePaths.push(alternative);
      branches.push(branch);
    } catch {
      // An otherwise high-scoring full route is not exposed when it cannot be
      // represented as a connected branch under Fifoo's graph invariants.
    }
  }

  const selectedCandidateKeys = new Set(
    diverse[0]?.scheduled?.map((candidate) => candidate.key) ?? [],
  );
  const candidateObservations = normalized.map((candidate, index) => ({
    ...candidate,
    candidateRank: index,
    wasEligible: candidate.hardExcluded !== true,
    selectedByChosenRoute: selectedCandidateKeys.has(candidate.key),
    predictedCompletionProbability: candidate.completionProbability,
  }));
  const exposedPaths = [chosenPath, ...validAlternativePaths];
  const routeObservations = exposedPaths.map((path, index) => ({
    routeKey: path.pathKey,
    routeKind: index === 0 ? 'chosen' : 'alternative',
    routeRank: index,
    wasSelected: index === 0,
    routeScore: path.routeScore ?? null,
    expectedProgress: path.expectedProgress ?? null,
    selectedCandidateKeys: path.selectedCandidateKeys ?? [],
    routeFeatures: {
      skippedDecisionGroups: path.skippedDecisionGroups ?? [],
      intervalCount: path.intervals.length,
      activityIntervalCount: path.intervals.filter((interval) => interval.sourceNodeID).length,
    },
  }));

  const result = {
    completedPath,
    chosenPath,
    alternativePaths: validAlternativePaths,
    alternativeBranches: branches,
    candidateRouteCount: ranked.length,
    candidateObservations,
    routeObservations,
    predictionMode: context.individualPriors
      ? 'personalized'
      : context.cohortPriors
        ? 'cohort-assisted'
      : 'cold-start',
  };
  validateDayGraph({ completedPath, chosenPath, alternativePaths: branches });
  return result;
}

/**
 * Re-optimizes only [decisionSecond, 86400). Immutable history and its
 * value-based progress budget are copied into the new graph unchanged.
 */
export function optimizeFutureRoutes({
  currentPrimaryPath,
  decisionSecond,
  candidates,
  context = {},
  ...options
} = {}) {
  const frozen = freezePrimaryPath(currentPrimaryPath, decisionSecond, {
    idSeed: `${context.idSeed ?? 'fifoo-routing'}:revision`,
  });
  const optimized = optimizeDayRoutes({
    ...options,
    candidates,
    context,
    initialCursorSecond: frozen.decisionSecond,
    totalPoints: frozen.remainingPotentialPoints,
    progressOffset: frozen.lockedPotentialPoints,
    completedPath: frozen.completedPath,
  });
  return {
    ...optimized,
    decisionSecond: frozen.decisionSecond,
    splitFromIntervalID: frozen.splitFromIntervalID,
    lockedPotentialPoints: frozen.lockedPotentialPoints,
    remainingPotentialPoints: frozen.remainingPotentialPoints,
    supersededFuturePath: frozen.supersededFuturePath,
  };
}

export const routingEngineInternals = Object.freeze({
  candidateScore,
  groupCandidates,
  placeCandidate,
  routeDistance,
  sampleConfidence,
  freezePathAt: freezePrimaryPath,
});
