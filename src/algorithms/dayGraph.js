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

function normalizedSleepWindows(context = {}) {
  if (Array.isArray(context?.sleepWindows) && context.sleepWindows.length) {
    return context.sleepWindows
      .map((window) => ({
        startSecond: Math.max(0, Math.min(DAY_END_SECOND, Math.trunc(finiteNumber(window?.startSecond, 0)))),
        endSecond: Math.max(0, Math.min(DAY_END_SECOND, Math.trunc(finiteNumber(window?.endSecond, 0)))),
      }))
      .filter((window) => window.endSecond > window.startSecond)
      .sort((a, b) => a.startSecond - b.startSecond);
  }

  const wakeSecond = Math.max(0, Math.min(DAY_END_SECOND, Math.trunc(
    finiteNumber(context?.dayStartSecond ?? context?.wakeSecond, 7 * 3600),
  )));
  const sleepSecond = Math.max(0, Math.min(DAY_END_SECOND, Math.trunc(
    finiteNumber(context?.dayEndSecond ?? context?.sleepSecond, 23 * 3600),
  )));

  // Normal schedule: sleep starts late in the day and continues across midnight.
  if (sleepSecond >= wakeSecond) {
    return [
      ...(wakeSecond > 0 ? [{ startSecond: 0, endSecond: wakeSecond }] : []),
      ...(sleepSecond < DAY_END_SECOND ? [{ startSecond: sleepSecond, endSecond: DAY_END_SECOND }] : []),
    ];
  }

  // Third-shift/day-sleep schedule: bedtime occurs earlier on the wall clock
  // than wake time, so the primary sleep window is a daytime interval.
  return [{ startSecond: sleepSecond, endSecond: wakeSecond }];
}

function intervalInsideAnyWindow(startSecond, endSecond, windows) {
  return windows.some((window) => (
    startSecond >= window.startSecond && endSecond <= window.endSecond
  ));
}

function defaultFillerKind({ startSecond, endSecond, previous, next, context }) {
  const sleepWindows = normalizedSleepWindows(context);
  if (intervalInsideAnyWindow(startSecond, endSecond, sleepWindows)) return 'sleep';

  // Awake time is metabolically fasting whenever the user is not eating.
  // Workouts/tasks/travel remain the visible interval when they exist; only
  // otherwise-unoccupied awake time becomes a visible fasting tile.
  return 'fasting';
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



function displayClock(secondValue) {
  const normalized = ((Math.trunc(Number(secondValue) || 0) % DAY_END_SECOND) + DAY_END_SECOND) % DAY_END_SECOND;
  const hour24 = Math.floor(normalized / 3600);
  const minute = Math.floor((normalized % 3600) / 60);
  const period = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = (hour24 % 12) || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function specialIntervalMetadata(interval, {
  presentationKind,
  hourNumber,
  cycleStartSecond,
} = {}) {
  return {
    ...(interval.metadata ?? {}),
    systemGenerated: interval.sourceNodeID == null || Boolean(interval.metadata?.generatedFiller),
    specialDayTile: true,
    presentationKind,
    hourNumber,
    cycleStartSecond,
    displayTitle: `${presentationKind === 'nap' ? 'Nap' : presentationKind === 'sleep' ? 'Sleep' : 'Fasting'} hour`,
    displayTimeRange: `${displayClock(interval.startSecond)}–${displayClock(interval.endSecond)}`,
  };
}

function splitAtCycleHours(interval, cycleStartSecond, { idSeed, label }) {
  const boundaries = [interval.startSecond];
  let nextBoundary = cycleStartSecond + (Math.floor((interval.startSecond - cycleStartSecond) / 3600) + 1) * 3600;
  while (nextBoundary > interval.startSecond && nextBoundary < interval.endSecond) {
    boundaries.push(nextBoundary);
    nextBoundary += 3600;
  }
  boundaries.push(interval.endSecond);

  const originalDuration = Math.max(1, interval.endSecond - interval.startSecond);
  const originalWeight = Math.max(0, finiteNumber(interval.progressWeightHint, 0));

  return boundaries.slice(0, -1).map((startSecond, index) => {
    const endSecond = boundaries[index + 1];
    const segmentDuration = Math.max(1, endSecond - startSecond);
    const hourNumber = Math.max(1, Math.floor((startSecond - cycleStartSecond) / 3600) + 1);
    return {
      ...interval,
      intervalID: stableUUID(`${idSeed}:${label}:${interval.intervalID}:${startSecond}:${endSecond}`),
      key: `${interval.key}:${label}-hour-${hourNumber}:${startSecond}`,
      candidateKey: interval.candidateKey ?? interval.key,
      startSecond,
      endSecond,
      // Hourly presentation must never multiply an activity's progress value.
      // Preserve the original span's aggregate weight by distributing it by
      // duration across the generated hourly pieces.
      progressWeightHint: originalWeight * (segmentDuration / originalDuration),
      completionEvaluator: interval.intervalKind === 'fasting'
        ? { type: 'fasting', plannedStartSecond: startSecond, plannedEndSecond: endSecond }
        : interval.completionEvaluator,
      metadata: specialIntervalMetadata({ ...interval, startSecond, endSecond }, {
        presentationKind: label,
        hourNumber,
        cycleStartSecond,
      }),
    };
  });
}

function splitForSleepClassification(interval, sleepWindows, idSeed) {
  const boundaryValues = sleepWindows.flatMap((window) => [window.startSecond, window.endSecond]);
  const boundaries = [
    interval.startSecond,
    ...boundaryValues.filter((value) => (
      value > interval.startSecond && value < interval.endSecond
    )),
    interval.endSecond,
  ].sort((a, b) => a - b);

  const originalDuration = Math.max(1, interval.endSecond - interval.startSecond);
  const originalWeight = Math.max(0, finiteNumber(interval.progressWeightHint, 0));

  return boundaries.slice(0, -1).map((startSecond, index) => {
    const endSecond = boundaries[index + 1];
    const segmentDuration = Math.max(1, endSecond - startSecond);
    return {
      ...interval,
      intervalID: stableUUID(`${idSeed}:sleep-classification:${interval.intervalID}:${startSecond}:${endSecond}`),
      key: `${interval.key}:sleep-classification:${startSecond}`,
      startSecond,
      endSecond,
      progressWeightHint: originalWeight * (segmentDuration / originalDuration),
    };
  });
}

function sleepCycleStartForPiece(piece, sleepWindows) {
  const window = sleepWindows.find((candidate) => (
    piece.startSecond >= candidate.startSecond && piece.endSecond <= candidate.endSecond
  ));
  if (!window) return null;

  if (window.startSecond === 0) {
    const previousNightWindow = [...sleepWindows]
      .reverse()
      .find((candidate) => candidate.endSecond === DAY_END_SECOND && candidate.startSecond > 0);
    return previousNightWindow ? previousNightWindow.startSecond - DAY_END_SECOND : 0;
  }
  return window.startSecond;
}

function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

/**
 * Fasting remains part of the continuous metabolic timeline even while a
 * workout/task/meal is visible. A fasting card is shown only when the whole
 * fasting-hour window has no competing activity. This avoids duplicate tiny
 * fasting fragments around a real stop while keeping the graph gap-free.
 */
function applyFastingTileVisibility(intervals) {
  const blockingIntervals = intervals.filter((interval) => (
    interval.intervalKind !== 'fasting'
    && interval.intervalKind !== 'sleep'
  ));

  return intervals.map((interval) => {
    if (interval.intervalKind !== 'fasting' || !interval.metadata?.specialDayTile) {
      return interval;
    }

    const hourNumber = Math.max(1, Math.trunc(finiteNumber(interval.metadata.hourNumber, 1)));
    const cycleStartSecond = Math.trunc(finiteNumber(
      interval.metadata.cycleStartSecond,
      interval.startSecond,
    ));
    const hourStart = cycleStartSecond + ((hourNumber - 1) * 3600);
    const hourEnd = hourStart + 3600;
    const blocked = blockingIntervals.some((candidate) => intervalsOverlap(
      hourStart,
      hourEnd,
      candidate.startSecond,
      candidate.endSecond,
    ));

    if (!blocked) return interval;

    return {
      ...interval,
      metadata: {
        ...(interval.metadata ?? {}),
        specialDayTile: false,
        suppressedByActivity: true,
      },
    };
  });
}

/**
 * Turns planner-level sleep/fasting spans into user-facing hourly system tiles.
 * Fasting numbering is based on elapsed fasting time, not on the number of
 * visible fasting cards, so workouts/tasks can temporarily hide a fasting tile
 * without resetting the metabolic clock.
 */
function materializeSpecialHourlyIntervals(intervals, { idSeed, context = {} } = {}) {
  const sleepWindows = normalizedSleepWindows(context);

  const meals = intervals.filter((interval) => interval.intervalKind === 'meal');
  const inferredPriorMealEnd = meals.length
    ? meals.at(-1).endSecond - DAY_END_SECOND
    : -5 * 3600;
  let fastingCycleStart = Math.trunc(finiteNumber(context?.priorMealEndSecond, inferredPriorMealEnd));
  let napCycleStart = null;
  const output = [];

  for (const interval of intervals) {
    if (interval.intervalKind === 'meal') {
      output.push(interval);
      fastingCycleStart = interval.endSecond;
      napCycleStart = null;
      continue;
    }

    if (interval.intervalKind === 'sleep') {
      const sleepPieces = splitForSleepClassification(
        interval,
        sleepWindows,
        idSeed,
      );

      for (const sleepPiece of sleepPieces) {
        const primarySleepCycleStart = sleepCycleStartForPiece(sleepPiece, sleepWindows);
        const isNap = primarySleepCycleStart == null;
        const label = isNap ? 'nap' : 'sleep';
        let cycleStartSecond;

        if (isNap) {
          if (napCycleStart == null
              || output.at(-1)?.intervalKind !== 'sleep'
              || output.at(-1)?.metadata?.presentationKind !== 'nap') {
            napCycleStart = sleepPiece.startSecond;
          }
          cycleStartSecond = napCycleStart;
        } else {
          cycleStartSecond = primarySleepCycleStart;
          napCycleStart = null;
        }

        output.push(...splitAtCycleHours(sleepPiece, cycleStartSecond, {
          idSeed,
          label,
        }));
      }
      continue;
    }

    napCycleStart = null;

    if (interval.intervalKind === 'fasting') {
      output.push(...splitAtCycleHours(interval, fastingCycleStart, {
        idSeed,
        label: 'fasting',
      }));
      continue;
    }

    output.push(interval);
  }

  return applyFastingTileVisibility(output);
}


function mergeWindows(windows = []) {
  const sorted = (windows ?? [])
    .map((window) => ({
      startSecond: Math.max(DAY_START_SECOND, Math.min(DAY_END_SECOND, Math.trunc(finiteNumber(window?.startSecond, 0)))),
      endSecond: Math.max(DAY_START_SECOND, Math.min(DAY_END_SECOND, Math.trunc(finiteNumber(window?.endSecond, 0)))),
    }))
    .filter((window) => window.endSecond > window.startSecond)
    .sort((a, b) => a.startSecond - b.startSecond || a.endSecond - b.endSecond);
  const merged = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (!previous || window.startSecond > previous.endSecond) {
      merged.push({ ...window });
    } else {
      previous.endSecond = Math.max(previous.endSecond, window.endSecond);
    }
  }
  return merged;
}

function systemStateSeed({
  intervalKind,
  startSecond,
  endSecond,
  idSeed,
  key,
  metadata = {},
}) {
  return {
    intervalID: stableUUID(`${idSeed}:state:${key}:${startSecond}:${endSecond}`),
    key,
    candidateKey: key,
    sourceNodeID: null,
    intervalKind,
    startSecond,
    endSecond,
    progressCategory: activityCategory(intervalKind),
    progressWeightHint: 0,
    potentialPoints: 0,
    plannedProgressStart: null,
    plannedProgressEnd: null,
    completionEvaluator: intervalKind === 'fasting'
      ? { type: 'fasting', plannedStartSecond: startSecond, plannedEndSecond: endSecond }
      : { type: 'presence' },
    lifecycleStatus: 'planned',
    metabolicContext: intervalKind === 'fasting' ? 'fasting' : null,
    metadata: {
      systemGenerated: true,
      primaryStateNode: true,
      routeActivity: true,
      routeMembership: 'primary',
      ...metadata,
    },
  };
}

/**
 * Generates the low-priority state-node layer for the authoritative primary
 * route. These nodes are deliberately independent of the dominant interval
 * topology, so they continue to exist underneath workouts/tasks/travel and can
 * become visible immediately when a higher-priority activity disappears.
 *
 * Priority is presentation-only: activity > sleep/nap > fasting.
 */
function buildPrimarySystemStateIntervals(scheduledIntervals, { idSeed, context = {} } = {}) {
  const baseSleepWindows = normalizedSleepWindows(context);
  const explicitSleepWindows = (scheduledIntervals ?? [])
    .filter((interval) => interval.intervalKind === 'sleep')
    .map((interval) => ({ startSecond: interval.startSecond, endSecond: interval.endSecond }));
  const combinedSleepWindows = mergeWindows([...baseSleepWindows, ...explicitSleepWindows]);
  const sleepStates = [];
  let napCycleStart = null;

  for (const window of combinedSleepWindows) {
    const seed = systemStateSeed({
      intervalKind: 'sleep',
      startSecond: window.startSecond,
      endSecond: window.endSecond,
      idSeed,
      key: `sleep-state-${window.startSecond}-${window.endSecond}`,
    });
    const classifiedPieces = splitForSleepClassification(seed, baseSleepWindows, `${idSeed}:state-classification`);
    for (const piece of classifiedPieces) {
      const primarySleepCycleStart = sleepCycleStartForPiece(piece, baseSleepWindows);
      const isNap = primarySleepCycleStart == null;
      if (isNap) {
        if (napCycleStart == null) napCycleStart = piece.startSecond;
      } else {
        napCycleStart = null;
      }
      const cycleStart = isNap ? napCycleStart : primarySleepCycleStart;
      sleepStates.push(...splitAtCycleHours(piece, cycleStart, {
        idSeed: `${idSeed}:sleep-state`,
        label: isNap ? 'nap' : 'sleep',
      }).map((interval) => ({
        ...interval,
        progressWeightHint: 0,
        potentialPoints: 0,
        metadata: {
          ...(interval.metadata ?? {}),
          primaryStateNode: true,
          displayPriority: 20,
        },
      })));
    }
  }

  const meals = (scheduledIntervals ?? [])
    .filter((interval) => interval.intervalKind === 'meal')
    .sort((a, b) => a.startSecond - b.startSecond || a.endSecond - b.endSecond);
  const inferredPriorMealEnd = meals.length
    ? meals.at(-1).endSecond - DAY_END_SECOND
    : -5 * 3600;
  let fastingCycleStart = Math.trunc(finiteNumber(context?.priorMealEndSecond, inferredPriorMealEnd));
  let cursor = DAY_START_SECOND;
  const fastingStates = [];

  const appendFasting = (startSecond, endSecond) => {
    if (endSecond <= startSecond) return;
    const seed = systemStateSeed({
      intervalKind: 'fasting',
      startSecond,
      endSecond,
      idSeed,
      key: `fasting-state-${startSecond}-${endSecond}`,
    });
    fastingStates.push(...splitAtCycleHours(seed, fastingCycleStart, {
      idSeed: `${idSeed}:fasting-state`,
      label: 'fasting',
    }).map((interval) => ({
      ...interval,
      progressWeightHint: 0,
      potentialPoints: 0,
      metadata: {
        ...(interval.metadata ?? {}),
        primaryStateNode: true,
        displayPriority: 10,
      },
    })));
  };

  for (const meal of meals) {
    if (meal.startSecond > cursor) appendFasting(cursor, meal.startSecond);
    cursor = Math.max(cursor, meal.endSecond);
    fastingCycleStart = meal.endSecond;
  }
  if (cursor < DAY_END_SECOND) appendFasting(cursor, DAY_END_SECOND);

  return [...sleepStates, ...fastingStates]
    .sort((a, b) => a.startSecond - b.startSecond
      || finiteNumber(b.metadata?.displayPriority, 0) - finiteNumber(a.metadata?.displayPriority, 0)
      || a.intervalID.localeCompare?.(b.intervalID) || 0);
}

function progressAtSecond(intervals, secondValue) {
  if (!Array.isArray(intervals) || !intervals.length) return 0;
  const point = Math.max(DAY_START_SECOND, Math.min(DAY_END_SECOND, finiteNumber(secondValue, 0)));
  const interval = intervals.find((candidate, index) => (
    point >= candidate.startSecond
      && (point < candidate.endSecond || (point === DAY_END_SECOND && index === intervals.length - 1))
  )) ?? intervals.at(-1);
  const start = finiteNumber(interval?.plannedProgressStart, interval?.plannedProgressEnd ?? 0);
  const end = finiteNumber(interval?.plannedProgressEnd, start);
  const duration = Math.max(1, finiteNumber(interval?.endSecond, 1) - finiteNumber(interval?.startSecond, 0));
  const ratio = Math.max(0, Math.min(1, (point - finiteNumber(interval?.startSecond, 0)) / duration));
  return start + ((end - start) * ratio);
}

export function projectSystemStateProgress(systemStateIntervals, primaryIntervals) {
  return (systemStateIntervals ?? []).map((interval) => ({
    ...interval,
    plannedProgressStart: progressAtSecond(primaryIntervals, interval.startSecond),
    plannedProgressEnd: progressAtSecond(primaryIntervals, interval.endSecond),
    potentialPoints: 0,
    progressWeightHint: 0,
  }));
}

function clipSystemStateIntervals(systemStateIntervals, startSecond, endSecond, idSeed) {
  const output = [];
  for (const interval of systemStateIntervals ?? []) {
    const start = Math.max(startSecond, interval.startSecond);
    const end = Math.min(endSecond, interval.endSecond);
    if (end <= start) continue;
    if (start === interval.startSecond && end === interval.endSecond) {
      output.push({ ...interval });
      continue;
    }
    const originalDuration = Math.max(1, interval.endSecond - interval.startSecond);
    const progressStart = finiteNumber(interval.plannedProgressStart, interval.plannedProgressEnd ?? 0);
    const progressEnd = finiteNumber(interval.plannedProgressEnd, progressStart);
    const progressAt = (point) => {
      const ratio = Math.max(0, Math.min(1, (point - interval.startSecond) / originalDuration));
      return progressStart + ((progressEnd - progressStart) * ratio);
    };
    output.push({
      ...interval,
      intervalID: stableUUID(`${idSeed}:state-clip:${interval.intervalID}:${start}:${end}`),
      startSecond: start,
      endSecond: end,
      plannedProgressStart: progressAt(start),
      plannedProgressEnd: progressAt(end),
      metadata: {
        ...(interval.metadata ?? {}),
        clippedFromStateIntervalID: interval.intervalID,
        displayTimeRange: `${displayClock(start)}–${displayClock(end)}`,
      },
    });
  }
  return output;
}

function neutralAlternativeCoverageInterval(interval) {
  if (!['sleep', 'fasting'].includes(interval.intervalKind)) return interval;
  return {
    ...interval,
    intervalKind: 'freeTime',
    progressCategory: 'other',
    progressWeightHint: 0,
    potentialPoints: 0,
    completionEvaluator: { type: 'presence' },
    metadata: {
      ...(interval.metadata ?? {}),
      systemGenerated: false,
      specialDayTile: false,
      presentationKind: null,
      displayTitle: null,
      alternativeCoveragePlaceholder: true,
      derivedFromPrimaryStateKind: interval.intervalKind,
    },
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
  const candidates = normalizedSleepWindows(context)
    .flatMap((window) => [window.startSecond, window.endSecond]);
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

  const materializedIntervals = materializeSpecialHourlyIntervals(
    applyMetabolicContexts(intervals),
    { idSeed: `${idSeed}:${pathKey}:special`, context },
  );

  const path = {
    pathID: stableUUID(`${idSeed}:path:${pathKey}`),
    pathKey,
    pathKind,
    originIntervalID: null,
    rejoinIntervalID: null,
    intervals: materializedIntervals,
    systemStateIntervals: pathKind === 'alternative'
      ? []
      : buildPrimarySystemStateIntervals(scheduled, {
          idSeed: `${idSeed}:${pathKey}:primary-states`,
          context,
        }).map((interval) => ({
          ...interval,
          metadata: {
            ...(interval.metadata ?? {}),
            routeActivity: true,
            routeMembership: pathKind,
          },
        })),
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

function progressTotal(intervals) {
  return intervals.reduce((total, interval) => total + Number(interval.potentialPoints ?? 0), 0);
}

function pathWith({ source, pathKind, pathKey, intervals, systemStateIntervals = [], idSeed }) {
  return {
    ...source,
    pathID: stableUUID(`${idSeed}:path:${pathKey}`),
    pathKey,
    pathKind,
    originIntervalID: null,
    rejoinIntervalID: null,
    intervals,
    systemStateIntervals,
  };
}

/**
 * Freezes the authoritative primary path at an exact end-exclusive second.
 * When the boundary cuts an interval, the elapsed side receives the original
 * value-based potential in full; its obsolete future tail receives none and
 * can be superseded without changing the historical denominator.
 */
export function freezePathAt(path, decisionSecond, { idSeed = 'fifoo-reroute' } = {}) {
  validateContinuousPath(path, { requireFullDay: true });
  const point = second(decisionSecond, 'decisionSecond', { allowEnd: true });
  if (point <= DAY_START_SECOND || point >= DAY_END_SECOND) {
    throw new RangeError('decisionSecond must be strictly inside the day.');
  }

  const completed = [];
  const future = [];
  let splitFromIntervalID = null;
  for (const interval of path.intervals) {
    if (interval.endSecond <= point) {
      completed.push({ ...interval });
    } else if (interval.startSecond >= point) {
      future.push({ ...interval });
    } else {
      const [left, right] = splitIntervalAt(interval, point, {
        idSeed: `${idSeed}:${interval.intervalID}`,
      });
      splitFromIntervalID = interval.intervalID;
      completed.push({
        ...left,
        lifecycleStatus: interval.lifecycleStatus === 'planned' ? 'active' : interval.lifecycleStatus,
        potentialPoints: Number(interval.potentialPoints ?? 0),
      });
      future.push({
        ...right,
        lifecycleStatus: 'superseded',
        potentialPoints: 0,
        plannedProgressStart: interval.plannedProgressEnd ?? interval.plannedProgressStart ?? 0,
        plannedProgressEnd: interval.plannedProgressEnd ?? interval.plannedProgressStart ?? 0,
      });
    }
  }

  const completedSystemStateIntervals = clipSystemStateIntervals(
    path.systemStateIntervals,
    DAY_START_SECOND,
    point,
    `${idSeed}:completed`,
  ).map((interval) => ({
    ...interval,
    lifecycleStatus: interval.endSecond <= point ? 'completed' : interval.lifecycleStatus,
    metadata: {
      ...(interval.metadata ?? {}),
      routeActivity: true,
      routeMembership: 'completed',
    },
  }));
  const futureSystemStateIntervals = clipSystemStateIntervals(
    path.systemStateIntervals,
    point,
    DAY_END_SECOND,
    `${idSeed}:future`,
  ).map((interval) => ({
    ...interval,
    lifecycleStatus: interval.startSecond <= point && interval.endSecond > point ? 'active' : 'planned',
    metadata: {
      ...(interval.metadata ?? {}),
      routeActivity: true,
      routeMembership: 'chosen',
    },
  }));
  const completedPath = pathWith({
    source: path,
    pathKind: 'completed',
    pathKey: 'completed',
    intervals: completed,
    systemStateIntervals: completedSystemStateIntervals,
    idSeed,
  });
  const supersededFuturePath = pathWith({
    source: path,
    pathKind: 'chosen',
    pathKey: 'superseded-future',
    intervals: future,
    systemStateIntervals: futureSystemStateIntervals,
    idSeed,
  });
  validateContinuousPath(completedPath);
  validateContinuousPath(supersededFuturePath);
  if (completedPath.intervals[0].startSecond !== DAY_START_SECOND
      || completedPath.intervals.at(-1).endSecond !== point
      || supersededFuturePath.intervals[0].startSecond !== point
      || supersededFuturePath.intervals.at(-1).endSecond !== DAY_END_SECOND) {
    throw new RangeError('Frozen and mutable paths must meet exactly at the decision second.');
  }
  const lockedPotentialPoints = progressTotal(completedPath.intervals);
  return {
    completedPath,
    supersededFuturePath,
    decisionSecond: point,
    splitFromIntervalID,
    lockedPotentialPoints,
    remainingPotentialPoints: Math.max(0, 100 - lockedPotentialPoints),
  };
}

/** Builds a temporary full-day primary path from immutable history + future. */
export function stitchPrimaryPaths(completedPath, chosenPath, {
  idSeed = 'fifoo-reroute',
  pathKey = 'stitched-primary',
} = {}) {
  validateContinuousPath(completedPath);
  validateContinuousPath(chosenPath);
  if (completedPath.intervals.at(-1).endSecond !== chosenPath.intervals[0].startSecond) {
    throw new RangeError('Completed and chosen paths must meet at the same decision second.');
  }
  const stitched = pathWith({
    source: chosenPath,
    pathKind: 'chosen',
    pathKey,
    intervals: [...completedPath.intervals, ...chosenPath.intervals],
    systemStateIntervals: [
      ...(completedPath.systemStateIntervals ?? []),
      ...(chosenPath.systemStateIntervals ?? []),
    ],
    idSeed,
  });
  validateContinuousPath(stitched, { requireFullDay: true });
  return stitched;
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
    const branchIntervals = candidate
      .slice(prefix + 1, candidateSuffix)
      .map(neutralAlternativeCoverageInterval);
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
      systemStateIntervals: [],
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
  if (completedPath) {
    if (completedPath.intervals[0].startSecond !== DAY_START_SECOND
        || completedPath.intervals.at(-1).endSecond !== chosenPath.intervals[0].startSecond
        || chosenPath.intervals.at(-1).endSecond !== DAY_END_SECOND) {
      throw new RangeError('Completed and chosen paths must cover [0, 86400) without a gap or overlap.');
    }
  }

  for (const path of alternativePaths) {
    validateContinuousPath(path);
    if ((path.systemStateIntervals ?? []).length) {
      throw new RangeError('Alternative paths cannot expose primary Sleep/Fasting state nodes.');
    }
    if (path.intervals.some((interval) => ['sleep', 'fasting'].includes(interval.intervalKind))) {
      throw new RangeError('Alternative paths cannot contain Sleep/Fasting state intervals.');
    }
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
  buildPrimarySystemStateIntervals,
  clipSystemStateIntervals,
  neutralAlternativeCoverageInterval,
  progressAtSecond,
});
