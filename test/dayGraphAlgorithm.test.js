import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileAlternativeBranches,
  compileContinuousDay,
  freezePathAt,
  splitIntervalAt,
  stitchPrimaryPaths,
  validateContinuousPath,
} from '../src/algorithms/dayGraph.js';
import { allocateDailyBudget } from '../src/algorithms/progressEngine.js';

test('continuous day assigns exactly one interval to every second', () => {
  const path = compileContinuousDay({
    idSeed: 'coverage-test',
    scheduledIntervals: [
      { key: 'breakfast', kind: 'meal', startSecond: 7 * 3600, endSecond: 7.5 * 3600 },
      { key: 'walk', kind: 'workout', startSecond: 10 * 3600, endSecond: 10.5 * 3600 },
      { key: 'lunch', kind: 'meal', startSecond: 12 * 3600, endSecond: 12.5 * 3600 },
    ],
  });

  assert.equal(path.intervals[0].startSecond, 0);
  assert.equal(path.intervals.at(-1).endSecond, 86_400);
  assert.ok(path.intervals.some((interval) => interval.intervalKind === 'fasting'));
  assert.equal(
    path.intervals.reduce((duration, interval) => duration + interval.endSecond - interval.startSecond, 0),
    86_400,
  );
  assert.equal(path.intervals.find((interval) => interval.key === 'walk').metabolicContext, 'fasting');
  assert.equal(validateContinuousPath(path, { requireFullDay: true }), true);
});

test('interval splitting preserves coverage at an arbitrary second', () => {
  const path = compileContinuousDay({ idSeed: 'split-test', scheduledIntervals: [] });
  const point = 14 * 3600 + 37 * 60 + 22;
  const original = path.intervals.find((interval) => interval.startSecond < point && interval.endSecond > point);
  const [left, right] = splitIntervalAt(original, point);
  assert.equal(left.startSecond, original.startSecond);
  assert.equal(left.endSecond, right.startSecond);
  assert.equal(right.endSecond, original.endSecond);
});

test('alternatives branch from chosen and rejoin without temporal gaps', () => {
  const common = [
    { key: 'breakfast', kind: 'meal', startSecond: 7 * 3600, endSecond: 7.5 * 3600 },
    { key: 'lunch', kind: 'meal', startSecond: 12 * 3600, endSecond: 12.5 * 3600 },
    { key: 'dinner', kind: 'meal', startSecond: 19 * 3600, endSecond: 19.5 * 3600 },
  ];
  const chosen = compileContinuousDay({
    idSeed: 'branch-test',
    pathKey: 'chosen',
    scheduledIntervals: [
      ...common,
      { key: 'gym', kind: 'workout', startSecond: 17 * 3600, endSecond: 18 * 3600 },
    ],
  });
  const alternative = compileContinuousDay({
    idSeed: 'branch-test',
    pathKey: 'walk-alternative',
    scheduledIntervals: [
      ...common,
      { key: 'walk', kind: 'movement', startSecond: 17 * 3600, endSecond: 17.5 * 3600 },
    ],
  });
  const [branch] = compileAlternativeBranches(chosen, [alternative], { idSeed: 'branch-test' });
  const origin = chosen.intervals.find((interval) => interval.intervalID === branch.originIntervalID);
  const rejoin = chosen.intervals.find((interval) => interval.intervalID === branch.rejoinIntervalID);

  assert.ok(origin);
  assert.ok(rejoin);
  assert.equal(branch.intervals[0].startSecond, origin.endSecond);
  assert.equal(branch.intervals.at(-1).endSecond, rejoin.startSecond);
});

test('overlapping primary intervals are rejected', () => {
  assert.throws(() => compileContinuousDay({
    scheduledIntervals: [
      { key: 'a', kind: 'task', startSecond: 100, endSecond: 300 },
      { key: 'b', kind: 'task', startSecond: 200, endSecond: 400 },
    ],
  }), /overlap/i);
});

test('future-only freeze splits at the exact second and locks value rather than duration', () => {
  const path = compileContinuousDay({
    idSeed: 'future-freeze',
    scheduledIntervals: [
      { key: 'breakfast', kind: 'meal', startSecond: 7 * 3600, endSecond: 7.5 * 3600, progressWeightHint: 10 },
      { key: 'dinner', kind: 'meal', startSecond: 19 * 3600, endSecond: 19.5 * 3600, progressWeightHint: 10 },
    ],
  });
  path.intervals = allocateDailyBudget(path.intervals);
  const decisionSecond = 14 * 3600 + 37 * 60 + 22;
  const original = path.intervals.find((interval) => (
    interval.startSecond < decisionSecond && interval.endSecond > decisionSecond
  ));
  const frozen = freezePathAt(path, decisionSecond, { idSeed: 'future-freeze-r1' });

  assert.equal(frozen.completedPath.intervals.at(-1).endSecond, decisionSecond);
  assert.equal(frozen.supersededFuturePath.intervals[0].startSecond, decisionSecond);
  assert.equal(frozen.completedPath.intervals.at(-1).potentialPoints, original.potentialPoints);
  assert.equal(frozen.supersededFuturePath.intervals[0].potentialPoints, 0);
  assert.equal(frozen.lockedPotentialPoints + frozen.remainingPotentialPoints, 100);
  assert.equal(
    stitchPrimaryPaths(frozen.completedPath, frozen.supersededFuturePath).intervals
      .reduce((seconds, interval) => seconds + interval.endSecond - interval.startSecond, 0),
    86_400,
  );
});

test('sleep fillers become numbered hourly tiles across midnight', () => {
  const path = compileContinuousDay({
    idSeed: 'sleep-hours',
    context: { wakeSecond: 5 * 3600, sleepSecond: 22 * 3600 },
    scheduledIntervals: [
      { key: 'breakfast', kind: 'meal', startSecond: 7 * 3600, endSecond: 7.5 * 3600 },
      { key: 'dinner', kind: 'meal', startSecond: 19 * 3600, endSecond: 19.5 * 3600 },
    ],
  });

  const morningSleep = path.intervals.filter((interval) => (
    interval.intervalKind === 'sleep' && interval.endSecond <= 5 * 3600
  ));
  const eveningSleep = path.intervals.filter((interval) => (
    interval.intervalKind === 'sleep' && interval.startSecond >= 22 * 3600
  ));

  assert.deepEqual(morningSleep.map((interval) => interval.metadata.displayTitle), [
    'Sleep Hour 3', 'Sleep Hour 4', 'Sleep Hour 5', 'Sleep Hour 6', 'Sleep Hour 7',
  ]);
  assert.deepEqual(eveningSleep.map((interval) => interval.metadata.displayTitle), [
    'Sleep Hour 1', 'Sleep Hour 2',
  ]);
  assert.equal(morningSleep[0].metadata.displayTimeRange, '12:00 AM–1:00 AM');
  assert.equal(eveningSleep[0].metadata.displayTimeRange, '10:00 PM–11:00 PM');
});

test('awake gaps are visible fasting tiles and fasting hour count continues through activities', () => {
  const path = compileContinuousDay({
    idSeed: 'fasting-hours',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      { key: 'breakfast', kind: 'meal', startSecond: 7 * 3600, endSecond: 8 * 3600 },
      { key: 'workout', kind: 'workout', startSecond: 9.5 * 3600, endSecond: 10 * 3600 },
      { key: 'lunch', kind: 'meal', startSecond: 12 * 3600, endSecond: 12.5 * 3600 },
    ],
  });

  assert.equal(path.intervals.some((interval) => interval.intervalKind === 'freeTime'), false);
  const afterBreakfast = path.intervals.filter((interval) => (
    interval.intervalKind === 'fasting'
      && interval.startSecond >= 8 * 3600
      && interval.endSecond <= 12 * 3600
  ));

  assert.equal(afterBreakfast[0].metadata.displayTitle, 'Fasting Hour 1');
  const afterWorkout = afterBreakfast.find((interval) => interval.startSecond === 10 * 3600);
  assert.ok(afterWorkout);
  assert.equal(afterWorkout.metadata.displayTitle, 'Fasting Hour 3');
  assert.equal(afterWorkout.metadata.hourNumber, 3);
});

test('scheduled daytime sleep is classified as a separately numbered nap', () => {
  const path = compileContinuousDay({
    idSeed: 'nap-hours',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      { key: 'nap', kind: 'sleep', startSecond: 14 * 3600, endSecond: 16.5 * 3600 },
    ],
  });
  const nap = path.intervals.filter((interval) => interval.metadata?.presentationKind === 'nap');
  assert.deepEqual(nap.map((interval) => interval.metadata.displayTitle), [
    'Nap Hour 1', 'Nap Hour 2', 'Nap Hour 3',
  ]);
  assert.equal(nap.at(-1).metadata.displayTimeRange, '4:00 PM–4:30 PM');
});

test('hourly special tiles preserve aggregate planner weights', () => {
  const path = compileContinuousDay({
    idSeed: 'special-weight-test',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      {
        key: 'breakfast',
        intervalKind: 'meal',
        startSecond: 8 * 3600,
        endSecond: 8 * 3600 + 1800,
        progressWeightHint: 2,
      },
    ],
  });

  const sleepWeight = path.intervals
    .filter((interval) => interval.intervalKind === 'sleep')
    .reduce((total, interval) => total + interval.progressWeightHint, 0);
  const fastingBeforeBreakfastWeight = path.intervals
    .filter((interval) => interval.intervalKind === 'fasting' && interval.endSecond <= 8 * 3600)
    .reduce((total, interval) => total + interval.progressWeightHint, 0);

  // Original filler spans are 00:00-07:00 sleep (weight 1) and
  // 07:00-08:00 fasting (weight .35); segmentation is presentation-only.
  assert.ok(Math.abs(sleepWeight - 2) < 1e-9);
  assert.ok(Math.abs(fastingBeforeBreakfastWeight - 0.35) < 1e-9);
});

test('fasting remains in graph but its visible tile is suppressed when that fasting hour contains an activity', () => {
  const path = compileContinuousDay({
    idSeed: 'fasting-visibility-test',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      {
        key: 'breakfast',
        intervalKind: 'meal',
        startSecond: 7 * 3600,
        endSecond: 8 * 3600,
      },
      {
        key: 'workout',
        intervalKind: 'workout',
        startSecond: 10 * 3600 + 15 * 60,
        endSecond: 10 * 3600 + 45 * 60,
      },
      {
        key: 'lunch',
        intervalKind: 'meal',
        startSecond: 12 * 3600,
        endSecond: 12 * 3600 + 30 * 60,
      },
    ],
  });

  const fastingHour3Pieces = path.intervals.filter((interval) => (
    interval.intervalKind === 'fasting'
    && interval.metadata?.hourNumber === 3
    && interval.metadata?.cycleStartSecond === 8 * 3600
  ));

  assert.ok(fastingHour3Pieces.length >= 1);
  assert.ok(fastingHour3Pieces.every((interval) => interval.metadata?.specialDayTile === false));
  assert.ok(fastingHour3Pieces.every((interval) => interval.metadata?.suppressedByActivity === true));

  const fastingHour4 = path.intervals.find((interval) => (
    interval.intervalKind === 'fasting'
    && interval.metadata?.hourNumber === 4
    && interval.metadata?.cycleStartSecond === 8 * 3600
  ));
  assert.equal(fastingHour4?.metadata?.displayTitle, 'Fasting Hour 4');
  assert.equal(fastingHour4?.metadata?.specialDayTile, true);
});

test('sleep crossing the wake boundary becomes overnight sleep then a nap', () => {
  const path = compileContinuousDay({
    idSeed: 'cross-wake-sleep-test',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      {
        key: 'late-sleep',
        intervalKind: 'sleep',
        startSecond: 5 * 3600,
        endSecond: 8 * 3600,
        progressWeightHint: 3,
      },
    ],
  });

  const lateSleep = path.intervals.filter((interval) => (
    interval.startSecond >= 5 * 3600 && interval.endSecond <= 8 * 3600
  ));
  assert.deepEqual(
    lateSleep.map((interval) => interval.metadata?.displayTitle),
    ['Sleep Hour 7', 'Sleep Hour 8', 'Nap Hour 1'],
  );
  assert.ok(Math.abs(
    lateSleep.reduce((total, interval) => total + interval.progressWeightHint, 0) - 3
  ) < 1e-9);
});

test('primary route always generates latent fasting state nodes underneath real activities', () => {
  const path = compileContinuousDay({
    idSeed: 'latent-fasting-states',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      { key: 'breakfast', kind: 'meal', startSecond: 8 * 3600, endSecond: 8.5 * 3600 },
      { key: 'workout', kind: 'workout', startSecond: 10 * 3600, endSecond: 11 * 3600 },
      { key: 'lunch', kind: 'meal', startSecond: 13 * 3600, endSecond: 13.5 * 3600 },
    ],
  });

  const workout = path.intervals.find((interval) => interval.key === 'workout');
  const fastingUnderWorkout = path.systemStateIntervals.filter((interval) => (
    interval.intervalKind === 'fasting'
    && interval.startSecond < workout.endSecond
    && workout.startSecond < interval.endSecond
  ));

  assert.ok(fastingUnderWorkout.length >= 1);
  assert.ok(fastingUnderWorkout.every((interval) => interval.metadata?.primaryStateNode === true));
  assert.ok(fastingUnderWorkout.every((interval) => interval.metadata?.displayPriority === 10));
});

test('primary route generates sleep and fasting together while sleep has the higher display priority', () => {
  const path = compileContinuousDay({
    idSeed: 'sleep-over-fasting-states',
    context: { wakeSecond: 6 * 3600, sleepSecond: 22 * 3600 },
    scheduledIntervals: [
      { key: 'dinner', kind: 'meal', startSecond: 19 * 3600, endSecond: 19.5 * 3600 },
    ],
  });

  const sleepHour = path.systemStateIntervals.find((interval) => (
    interval.metadata?.presentationKind === 'sleep'
    && interval.startSecond === 22 * 3600
  ));
  const fastingAtSleep = path.systemStateIntervals.find((interval) => (
    interval.intervalKind === 'fasting'
    && interval.startSecond < 23 * 3600
    && interval.endSecond > 22 * 3600
  ));

  assert.ok(sleepHour);
  assert.ok(fastingAtSleep);
  assert.equal(sleepHour.metadata.displayPriority, 20);
  assert.equal(fastingAtSleep.metadata.displayPriority, 10);
});

test('alternative branches never expose sleep or fasting state nodes', () => {
  const context = { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 };
  const chosen = compileContinuousDay({
    idSeed: 'decision-state-alt',
    pathKey: 'chosen',
    context,
    scheduledIntervals: [
      { key: 'breakfast-8', candidateKey: 'breakfast-8', kind: 'meal', startSecond: 8 * 3600, endSecond: 8.5 * 3600 },
      { key: 'lunch', kind: 'meal', startSecond: 13 * 3600, endSecond: 13.5 * 3600 },
    ],
  });
  const alternative = compileContinuousDay({
    idSeed: 'decision-state-alt',
    pathKey: 'breakfast-9-alternative',
    context,
    scheduledIntervals: [
      { key: 'breakfast-9', candidateKey: 'breakfast-9', kind: 'meal', startSecond: 9 * 3600, endSecond: 9.5 * 3600 },
      { key: 'lunch', kind: 'meal', startSecond: 13 * 3600, endSecond: 13.5 * 3600 },
    ],
  });

  const [branch] = compileAlternativeBranches(chosen, [alternative], { idSeed: 'decision-state-alt' });

  assert.deepEqual(branch.systemStateIntervals, []);
  assert.equal(branch.intervals.some((interval) => ['sleep', 'fasting'].includes(interval.intervalKind)), false);
  assert.ok(branch.intervals.some((interval) => interval.key.includes('breakfast-9')));
});

test('primary system-state layer keeps overnight sleep and daytime nap classification across the wake boundary', () => {
  const path = compileContinuousDay({
    idSeed: 'primary-state-cross-wake',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      { key: 'late-sleep-decision', kind: 'sleep', startSecond: 5 * 3600, endSecond: 8 * 3600 },
    ],
  });

  const relevant = path.systemStateIntervals.filter((interval) => (
    interval.startSecond >= 5 * 3600
    && interval.endSecond <= 8 * 3600
    && ['sleep', 'nap'].includes(interval.metadata?.presentationKind)
  ));
  assert.deepEqual(relevant.map((interval) => interval.metadata.displayTitle), [
    'Sleep Hour 7', 'Sleep Hour 8', 'Nap Hour 1',
  ]);
});
