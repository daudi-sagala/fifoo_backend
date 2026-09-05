import test from 'node:test';
import assert from 'node:assert/strict';

import { compileContinuousDay } from '../src/algorithms/dayGraph.js';
import { allocateDailyBudget, calculateProgressSnapshot } from '../src/algorithms/progressEngine.js';
import { dayPlanningInternals } from '../src/services/dayPlanning.js';

test('foreground sleep and fasting intervals are actionable system activity nodes', () => {
  const path = compileContinuousDay({
    idSeed: 'actionable-system-activities',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      { key: 'breakfast', kind: 'meal', startSecond: 8 * 3600, endSecond: 8.5 * 3600 },
      { key: 'lunch', kind: 'meal', startSecond: 13 * 3600, endSecond: 13.5 * 3600 },
    ],
  });

  const sleep = path.intervals.find((interval) => interval.metadata?.stateKind === 'sleep');
  const fasting = path.intervals.find((interval) => interval.metadata?.stateKind === 'fasting');

  assert.ok(sleep);
  assert.ok(fasting);
  assert.equal(sleep.metadata.systemActivityNodeID, sleep.intervalID);
  assert.equal(fasting.metadata.systemActivityNodeID, fasting.intervalID);
  assert.deepEqual(sleep.metadata.availableActions, ['iAmAwake']);
  assert.deepEqual(fasting.metadata.availableActions, ['breakFast']);
  assert.equal(sleep.metadata.routeActivity, true);
  assert.equal(fasting.metadata.routeActivity, true);
  assert.ok(path.systemStateIntervals.every((interval) => interval.metadata?.stateOnly === true));
  assert.ok(path.systemStateIntervals.every((interval) => interval.potentialPoints === 0));
});

test('I Am Awake clips the current derived sleep window even when context only has wake/bed times', () => {
  const action = dayPlanningInternals.normalizeSystemAction(
    { action: 'iAmAwake', intervalID: 'sleep-id', stateKind: 'sleep' },
    6 * 3600 + 15 * 60,
  );
  const context = dayPlanningInternals.contextAfterSystemAction({
    wakeSecond: 7 * 3600,
    sleepSecond: 23 * 3600,
  }, action);

  assert.deepEqual(context.sleepWindows, [
    { startSecond: 0, endSecond: 6 * 3600 + 15 * 60 },
    { startSecond: 23 * 3600, endSecond: 86_400 },
  ]);
  assert.equal(context.systemStateOverride.wokeAtSecond, 6 * 3600 + 15 * 60);
});

test('Break Fast inserts a required eating-window fact at the reroute boundary', () => {
  const action = dayPlanningInternals.normalizeSystemAction(
    { action: 'breakFast', intervalID: 'fast-id', stateKind: 'fasting' },
    10 * 3600 + 5 * 60,
  );
  const candidates = dayPlanningInternals.candidatesAfterSystemAction([
    { key: 'lunch', kind: 'meal', fixedStartSecond: 13 * 3600 },
  ], action);

  const boundary = candidates[0];
  assert.equal(boundary.kind, 'meal');
  assert.equal(boundary.required, true);
  assert.equal(boundary.fixedStartSecond, 10 * 3600 + 5 * 60);
  assert.equal(boundary.metadata.systemGeneratedAction, true);
  assert.equal(boundary.metadata.action, 'breakFast');
  assert.equal(candidates[1].key, 'lunch');
});

test('live system activity progress changes dayProgress without mutating ledger earnedPoints', () => {
  const path = compileContinuousDay({
    idSeed: 'live-system-progress',
    context: { wakeSecond: 7 * 3600, sleepSecond: 23 * 3600 },
    scheduledIntervals: [
      { key: 'breakfast', kind: 'meal', startSecond: 8 * 3600, endSecond: 8.5 * 3600 },
    ],
  });
  const intervals = allocateDailyBudget(path.intervals);
  const snapshot = calculateProgressSnapshot({
    intervals,
    ledgerEntries: [],
    nowSecond: 6 * 3600 + 30 * 60,
  });

  assert.equal(snapshot.earnedPoints, 0);
  assert.ok(snapshot.liveSystemEarnedPoints > 0);
  assert.equal(snapshot.effectiveEarnedPoints, snapshot.liveSystemEarnedPoints);
  assert.ok(snapshot.dayProgress > 0);
});
