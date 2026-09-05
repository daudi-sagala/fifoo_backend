import test from 'node:test';
import assert from 'node:assert/strict';

import { compileContinuousDay } from '../src/algorithms/dayGraph.js';
import {
  allocateDailyBudget,
  calculateProgressSnapshot,
  createLedgerEntry,
  evaluateCompletion,
} from '../src/algorithms/progressEngine.js';

function plannedDay() {
  const path = compileContinuousDay({
    idSeed: 'progress-test',
    scheduledIntervals: [
      {
        key: 'breakfast', kind: 'meal', startSecond: 7 * 3600, endSecond: 7.5 * 3600,
        progressCategory: 'nutrition', progressWeightHint: 10,
        completionEvaluator: { type: 'mealComposite' },
      },
      {
        key: 'workout', kind: 'workout', startSecond: 17 * 3600, endSecond: 17 * 3600 + 2400,
        progressCategory: 'exercise', progressWeightHint: 25,
        completionEvaluator: { type: 'duration', plannedSeconds: 2400 },
      },
      {
        key: 'dinner', kind: 'meal', startSecond: 19 * 3600, endSecond: 19.5 * 3600,
        progressCategory: 'nutrition', progressWeightHint: 10,
        completionEvaluator: { type: 'binary' },
      },
    ],
  });
  return allocateDailyBudget(path.intervals);
}

test('daily budget is exactly 100 and fasting rewards are capped', () => {
  const intervals = plannedDay();
  const total = intervals.reduce((value, interval) => value + interval.potentialPoints, 0);
  assert.ok(Math.abs(total - 100) < 0.000001);
  const fastingTotal = intervals
    .filter((interval) => interval.intervalKind === 'fasting')
    .reduce((total, interval) => total + interval.potentialPoints, 0);
  assert.ok(fastingTotal <= 4.000001);
});

test('completion evaluators support partial workouts and composite meals', () => {
  const intervals = plannedDay();
  const workout = intervals.find((interval) => interval.key === 'workout');
  const breakfast = intervals.find((interval) => interval.key === 'breakfast');
  assert.equal(evaluateCompletion(workout, { completedSeconds: 1680 }), 0.7);
  assert.equal(evaluateCompletion(breakfast, {
    components: { calories: 1, protein: 0.8, foodQuality: 0.75, timing: 1 },
  }), 0.89);
});

test('skipped work remains in the denominator while superseded work creates no penalty', () => {
  const intervals = plannedDay();
  const breakfast = intervals.find((interval) => interval.key === 'breakfast');
  const workout = intervals.find((interval) => interval.key === 'workout');
  const ledger = [
    createLedgerEntry(breakfast, { completed: true, status: 'completed' }),
    createLedgerEntry(workout, { status: 'skipped', reasonCode: 'user_skipped' }),
  ];
  const snapshot = calculateProgressSnapshot({ intervals, ledgerEntries: ledger, nowSecond: 18 * 3600 });
  assert.equal(snapshot.plannedPoints, 100);
  assert.equal(snapshot.earnedPoints, breakfast.potentialPoints);
  assert.ok(snapshot.dayProgress < 1);

  const superseded = createLedgerEntry(workout, { status: 'superseded', reasonCode: 'rerouted' });
  assert.equal(superseded.earnedPoints, 0);
  assert.equal(superseded.status, 'superseded');
});

test('a rerouted suffix receives exactly the remaining progress budget', () => {
  const path = compileContinuousDay({
    idSeed: 'remaining-budget',
    scheduledIntervals: [
      { key: 'walk', kind: 'movement', startSecond: 17 * 3600, endSecond: 17.5 * 3600, progressWeightHint: 5 },
      { key: 'dinner', kind: 'meal', startSecond: 19 * 3600, endSecond: 19.5 * 3600, progressWeightHint: 8 },
    ],
  });
  const allocated = allocateDailyBudget(path.intervals, { totalPoints: 37.25 });
  assert.equal(
    allocated.reduce((total, interval) => total + interval.potentialPoints, 0),
    37.25,
  );
  assert.equal(allocated.at(-1).plannedProgressEnd, 37.25);
});
