import { stableUUID } from '../lib/stableUUID.js';

export const DAY_START_SECOND = 0;
export const DAY_END_SECOND = 86_400;

const PRIMARY_KINDS = new Set(['chosen', 'completed']);
const INTERVAL_KINDS = new Set([
  'meal',
  'workout',
  'task',
  'sleep',
  'fasting',
  'recovery',
  'movement',
  'travel',
  'freeTime',
]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function second(value, name, { allowEnd = false } = {}) {
  const result = Math.trunc(finiteNumber(value, Number.NaN));
  const maximum = allowEnd ? DAY_END_SECOND : DAY_END_SECOND - 1;
  if (!Number.isInteger(result) || result < DAY_START_SECOND || result > maximum) {
    throw new RangeError(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return result;
}

function kind(value, fallback = 'freeTime') {
  const candidate = String(value ?? fallback).trim();
  return INTERVAL_KINDS.has(candidate) ? candidate : fallback;
}

function intervalIdentity(interval) {
  return [
    interval.candidateKey ?? interval.key,
    interval.intervalKind,
    interval.startSecond,
    interval.endSecond,
  ].join(':');
}

function activityCategory(intervalKind) {
  switch (intervalKind) {
    case 'meal':
    case 'fasting': return 'nutrition';
    case 'workout': return 'exercise';
    case 'movement': return 'movement';
    case 'sleep':
    case 'recovery': return 'recovery';
    case 'task': return 'habits';
    default: return 'other';
  }
}

function defaultFillerKind({ startSecond, endSecond, previous, next, context }) {
  const wakeSecond = Math.max(0, Math.min(DAY_END_SECOND, Math.trunc(
    finiteNumber(context?.wakeSecond, 7 * 3600),
  )));
  const sleepSecond = Math.max(wakeSecond, Math.min(DAY_END_SECOND, Math.trunc(
    finiteNumber(context?.sleepSecond, 23 * 3600),
  )));

  if (endSecond <= wakeSecond || startSecond >= sleepSecond) return 'sleep';

  // Fasting is the primary metabolic state between eating windows. It remains
  // metadata on top of workouts/tasks that happen during the same period; only
  // otherwise-unoccupied time becomes a visible fasting interval.
  const previousWasMeal = previous?.intervalKind === 'meal';
  const nextIsMeal = next?.intervalKind === 'meal';
  const betweenWakeAndFirstMeal = !previous && nextIsMeal;
  if (previousWasMeal || nextIsMeal || betweenWakeAndFirstMeal) return 'fasting';

  return 'freeTime';
}

function normalizeScheduledInterval(raw, index, { idSeed, pathKey }) {
  const startSecond = second(raw.startSecond, `scheduledIntervals[${index}].startSecond`);
  const endSecond = second(raw.endSecond, `scheduledIntervals[${index}].endSecond`, { allowEnd: true });
  if (endSecond <= startSecond) {
    throw new RangeError(`scheduledIntervals[${index}] must have endSecond > startSecond.`);
  }

  const intervalKind = kind(raw.intervalKind ?? raw.kind, 'task');
  const key = String(raw.key ?? raw.candidateKey ?? `scheduled-${index}`).trim();
  if (!key) throw new TypeError(`scheduledIntervals[${index}].key cannot be empty.`);

  return {
    intervalID: raw.intervalID ?? stableUUID(`${idSeed}:${pathKey}:${key}:${startSecond}:${endSecond}`),
    key,
    candidateKey: String(raw.candidateKey ?? key),
    sourceNodeID: raw.sourceNodeID ?? raw.nodeID ?? null,
    intervalKind,
    startSecond,
    endSecond,
    progressCategory: String(raw.progressCategory ?? activityCategory(intervalKind)),
    progressWeightHint: Math.max(0, finiteNumber(raw.progressWeightHint ?? raw.progressWeight, 1)),
    completionEvaluator: raw.completionEvaluator ?? { type: 'binary' },
    lifecycleStatus: raw.lifecycleStatus ?? 'planned',
    metabolicContext: raw.metabolicContext ?? (intervalKind === 'meal' ? 'fed' : null),
    metadata: raw.metadata ?? {},
  };
}

function makeFillerInterval({
  startSecond,
  endSecond,
  previous,
  next,
  fillerIndex,
  idSeed,
  pathKey,
  context,
  fillerResolver,
}) {
  const resolved = fillerResolver({ startSecond, endSecond, previous, next, context });
  const intervalKind = kind(typeof resolved === 'string' ? resolved : resolved?.intervalKind);
  const key = String(resolved?.key ?? `${intervalKind}-${startSecond}-${endSecond}`);
  const defaultEvaluator = intervalKind === 'fasting'
    ? { type: 'fasting', plannedStartSecond: startSecond, plannedEndSecond: endSecond }
    : { type: 'presence' };

  return {
    intervalID: stableUUID(`${idSeed}:${pathKey}:filler:${fillerIndex}:${key}`),
    key,
    candidateKey: key,
    sourceNodeID: null,
    intervalKind,
    startSecond,
    endSecond,
    progressCategory: String(resolved?.progressCategory ?? activityCategory(intervalKind)),
    progressWeightHint: Math.max(0, finiteNumber(
      resolved?.progressWeightHint,
      intervalKind === 'fasting' ? 0.35 : intervalKind === 'sleep' ? 1 : 0,
    )),
    completionEvaluator: resolved?.completionEvaluator ?? defaultEvaluator,
    lifecycleStatus: 'planned',
    metabolicContext: intervalKind === 'fasting' ? 'fasting' : null,
    metadata: { generatedFiller: true, ...(resolved?.metadata ?? {}) },
  };
}

function applyMetabolicContexts(intervals) {
  let hasReachedEatingWindow = false;
  return intervals.map((interval) => {
    if (interval.intervalKind === 'meal') {
      hasReachedEatingWindow = true;
      return { ...interval, metabolicContext: interval.metabolicContext ?? 'fed' };
    }
    if (interval.metabolicContext) return interval;
    if (interval.intervalKind === 'fasting' || hasReachedEatingWindow) {
      return { ...interval, metabolicContext: 'fasting' };
    }
    return interval;
  });
}

function fillerBoundaries(startSecond, endSecond, context) {
  const candidates = [
    Math.trunc(finiteNumber(context?.wakeSecond, 7 * 3600)),
    Math.trunc(finiteNumber(context?.sleepSecond, 23 * 3600)),
  ];
  return [
    startSecond,
    ...candidates.filter((value) => value > startSecond && value < endSecond),
    endSecond,
  ].sort((a, b) => a - b);
}

function appendFillerIntervals({
  intervals,
  startSecond,
  endSecond,
  next,
  fillerIndex,
  idSeed,
  pathKey,
  context,
  fillerResolver,
}) {
  const boundaries = fillerBoundaries(startSecond, endSecond, context);
  let index = fillerIndex;
  for (let boundaryIndex = 0; boundaryIndex + 1 < boundaries.length; boundaryIndex += 1) {
    intervals.push(makeFillerInterval({
      startSecond: boundaries[boundaryIndex],
      endSecond: boundaries[boundaryIndex + 1],
      previous: intervals.at(-1) ?? null,
      next,
      fillerIndex: index,
      idSeed,
      pathKey,
      context,
      fillerResolver,
    }));
    index += 1;
  }
  return index;
}

/**
 * Compiles scheduled activities into one end-exclusive path covering every
 * second in [00:00:00, 24:00:00). No 86,400-row expansion is needed: each node
 * is a maximal interval and filler intervals represent otherwise-empty time.
 */
export function compileContinuousDay({
  scheduledIntervals,
  idSeed = 'fifoo-day',
  pathKey = 'chosen',
  pathKind = 'chosen',
  context = {},
  fillerResolver = defaultFillerKind,
} = {}) {
  if (!Array.isArray(scheduledIntervals)) {
    throw new TypeError('scheduledIntervals must be an array.');
  }

  const scheduled = scheduledIntervals
    .map((raw, index) => normalizeScheduledInterval(raw, index, { idSeed, pathKey }))
    .sort((a, b) => a.startSecond - b.startSecond || a.endSecond - b.endSecond || a.key.localeCompare(b.key));

  for (let index = 1; index < scheduled.length; index += 1) {
    if (scheduled[index].startSecond < scheduled[index - 1].endSecond) {
      throw new RangeError(
        `Scheduled intervals overlap: ${scheduled[index - 1].key} and ${scheduled[index].key}.`,
      );
    }
  }

  const intervals = [];
  let cursor = DAY_START_SECOND;
  let fillerIndex = 0;
  for (let index = 0; index < scheduled.length; index += 1) {
    const current = scheduled[index];
    if (current.startSecond > cursor) {
      fillerIndex = appendFillerIntervals({
        intervals,
        startSecond: cursor,
        endSecond: current.startSecond,
        next: current,
        fillerIndex,
        idSeed,
        pathKey,
        context,
        fillerResolver,
      });
    }
    intervals.push(current);
    cursor = current.endSecond;
  }

  if (cursor < DAY_END_SECOND) {
    fillerIndex = appendFillerIntervals({
      intervals,
      startSecond: cursor,
      endSecond: DAY_END_SECOND,
      next: null,
      fillerIndex,
      idSeed,
      pathKey,
      context,
      fillerResolver,
    });
  }

  const path = {
    pathID: stableUUID(`${idSeed}:path:${pathKey}`),
    pathKey,
    pathKind,
    originIntervalID: null,
    rejoinIntervalID: null,
    intervals: applyMetabolicContexts(intervals),
  };
  validateContinuousPath(path, { requireFullDay: PRIMARY_KINDS.has(pathKind) });
  return path;
}

export function splitIntervalAt(interval, splitSecond, { idSeed = interval.intervalID } = {}) {
  const point = second(splitSecond, 'splitSecond');
  if (point <= interval.startSecond || point >= interval.endSecond) {
    throw new RangeError('splitSecond must fall strictly inside the interval.');
  }
  const left = {
    ...interval,
    intervalID: stableUUID(`${idSeed}:left:${point}`),
    endSecond: point,
    metadata: { ...(interval.metadata ?? {}), splitFrom: interval.intervalID },
  };
  const right = {
    ...interval,
    intervalID: stableUUID(`${idSeed}:right:${point}`),
    startSecond: point,
    metadata: { ...(interval.metadata ?? {}), splitFrom: interval.intervalID },
  };
  return [left, right];
}

export function validateContinuousPath(path, { requireFullDay = false } = {}) {
  if (!path || !Array.isArray(path.intervals) || !path.intervals.length) {
    throw new TypeError('A day path requires at least one interval.');
  }
  const intervals = path.intervals;
  for (let index = 0; index < intervals.length; index += 1) {
    const interval = intervals[index];
    second(interval.startSecond, `intervals[${index}].startSecond`);
    second(interval.endSecond, `intervals[${index}].endSecond`, { allowEnd: true });
    if (interval.endSecond <= interval.startSecond) {
      throw new RangeError(`intervals[${index}] must have positive duration.`);
    }
    if (index > 0 && intervals[index - 1].endSecond !== interval.startSecond) {
      throw new RangeError(`Path ${path.pathKey ?? path.pathID} has a temporal gap or overlap.`);
    }
  }
  if (requireFullDay
      && (intervals[0].startSecond !== DAY_START_SECOND || intervals.at(-1).endSecond !== DAY_END_SECOND)) {
    throw new RangeError('A primary day path must cover exactly [0, 86400).');
  }
  return true;
}

/**
 * Converts complete alternative schedules into branch records by sharing the
 * longest identical prefix and suffix with the chosen path.
 */
export function compileAlternativeBranches(primaryPath, alternativePaths, { idSeed = 'fifoo-day' } = {}) {
  validateContinuousPath(primaryPath, { requireFullDay: true });
  const primary = primaryPath.intervals;

  return (alternativePaths ?? []).map((alternative, alternativeIndex) => {
    validateContinuousPath(alternative, { requireFullDay: true });
    const candidate = alternative.intervals;
    let prefix = -1;
    const prefixLimit = Math.min(primary.length, candidate.length);
    while (prefix + 1 < prefixLimit
      && intervalIdentity(primary[prefix + 1]) === intervalIdentity(candidate[prefix + 1])) {
      prefix += 1;
    }

    let primarySuffix = primary.length;
    let candidateSuffix = candidate.length;
    while (primarySuffix - 1 > prefix
      && candidateSuffix - 1 > prefix
      && intervalIdentity(primary[primarySuffix - 1]) === intervalIdentity(candidate[candidateSuffix - 1])) {
      primarySuffix -= 1;
      candidateSuffix -= 1;
    }

    if (prefix < 0) {
      throw new RangeError('Every alternative must originate from a completed or chosen interval.');
    }
    if (candidateSuffix <= prefix + 1) {
      throw new RangeError('An alternative must contain a meaningfully different interval.');
    }

    const origin = primary[prefix];
    const rejoin = primarySuffix < primary.length ? primary[primarySuffix] : null;
    const branchIntervals = candidate.slice(prefix + 1, candidateSuffix);
    if (branchIntervals[0].startSecond !== origin.endSecond) {
      throw new RangeError('An alternative must start exactly where its origin interval ends.');
    }
    if (rejoin && branchIntervals.at(-1).endSecond !== rejoin.startSecond) {
      throw new RangeError('An alternative must end exactly where its rejoin interval starts.');
    }
    if (!rejoin && branchIntervals.at(-1).endSecond !== DAY_END_SECOND) {
      throw new RangeError('A non-rejoining alternative must continue through end-of-day.');
    }

    const branch = {
      pathID: alternative.pathID ?? stableUUID(`${idSeed}:alternative:${alternativeIndex}`),
      pathKey: alternative.pathKey ?? `alternative-${alternativeIndex + 1}`,
      pathKind: 'alternative',
      originIntervalID: origin.intervalID,
      rejoinIntervalID: rejoin?.intervalID ?? null,
      intervals: branchIntervals,
      routeScore: alternative.routeScore ?? null,
      expectedProgress: alternative.expectedProgress ?? null,
    };
    validateContinuousPath(branch);
    return branch;
  });
}

export function validateDayGraph({ completedPath = null, chosenPath, alternativePaths = [] } = {}) {
  const intervalOwner = new Map();
  const primaryPaths = [completedPath, chosenPath].filter(Boolean);
  for (const path of primaryPaths) {
    validateContinuousPath(path, { requireFullDay: path.pathKind === 'chosen' && !completedPath });
    for (const interval of path.intervals) intervalOwner.set(interval.intervalID, path.pathKind);
  }

  for (const path of alternativePaths) {
    validateContinuousPath(path);
    const originKind = intervalOwner.get(path.originIntervalID);
    if (!PRIMARY_KINDS.has(originKind)) {
      throw new RangeError('Alternative origin must belong to a completed or chosen path.');
    }
    if (path.rejoinIntervalID && !intervalOwner.has(path.rejoinIntervalID)) {
      throw new RangeError('Alternative rejoin must reference a known chosen/completed interval.');
    }
    for (const interval of path.intervals) intervalOwner.set(interval.intervalID, 'alternative');
  }
  return true;
}

export const dayGraphInternals = Object.freeze({
  activityCategory,
  applyMetabolicContexts,
  defaultFillerKind,
  intervalIdentity,
});
