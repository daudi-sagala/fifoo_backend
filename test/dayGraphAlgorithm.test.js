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
