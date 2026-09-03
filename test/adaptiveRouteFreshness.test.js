import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAdaptiveRerouteCandidates,
  evaluateAdaptiveRouteFreshness,
} from '../src/algorithms/adaptiveRouteFreshness.js';

function interval({
  id,
  key = id,
  nodeID = null,
  kind = 'task',
  start,
  end,
  points = 10,
  probability = 0.7,
  group = key,
} = {}) {
  return {
    intervalID: id,
    key,
    candidateKey: key,
    sourceNodeID: nodeID,
    intervalKind: kind,
    startSecond: start,
    endSecond: end,
    progressCategory: kind === 'meal' ? 'nutrition' : 'routine',
    progressWeightHint: points,
    potentialPoints: points,
    completionEvaluator: { type: 'binary' },
    metadata: {
      completionProbability: probability,
      decisionGroup: group,
    },
  };
}

function plan(chosen, alternatives = []) {
  return {
    chosenPath: {
      pathID: 'chosen',
      pathKey: 'chosen',
      pathKind: 'chosen',
      intervals: chosen,
    },
    alternativeBranches: alternatives.map((intervals, index) => ({
      pathID: `alt-${index}`,
      pathKey: `alt-${index}`,
      pathKind: 'alternative',
      intervals,
    })),
  };
}

test('adaptive freshness ignores system filler intervals', () => {
  const dayPlan = plan([
    interval({ id: 'sleep-1', start: 0, end: 3600, nodeID: null, kind: 'sleep' }),
    interval({ id: 'fast-1', start: 3600, end: 7200, nodeID: null, kind: 'fasting' }),
  ]);

  const result = evaluateAdaptiveRouteFreshness({
    dayPlan,
    nowSecond: 7200,
    progressSnapshot: { expectedDayFinish: 0.2 },
  });

  assert.equal(result.shouldReroute, false);
  assert.equal(result.reason, 'no_activity_intervals');
});

test('missed uncompleted activity triggers an adaptive reroute', () => {
  const breakfast = interval({
    id: 'breakfast',
    key: 'meal-breakfast',
    nodeID: 'node-breakfast',
    kind: 'meal',
    start: 7 * 3600,
    end: 7 * 3600 + 1800,
  });
  const workout = interval({
    id: 'workout',
    key: 'workout-am',
    nodeID: 'node-workout',
    kind: 'workout',
    start: 9 * 3600,
    end: 10 * 3600,
  });

  const result = evaluateAdaptiveRouteFreshness({
    dayPlan: plan([breakfast, workout]),
    nowSecond: 8 * 3600,
    missedGraceSeconds: 300,
    progressSnapshot: { expectedDayFinish: 0.8 },
  });

  assert.equal(result.shouldReroute, true);
  assert.equal(result.trigger, 'activity_window_missed');
  assert.equal(result.sourceNodeID, 'node-breakfast');
  assert.equal(result.affectedIntervalCount, 1);
});

test('completed or skipped activities do not create a stale-route trigger', () => {
  const breakfast = interval({
    id: 'breakfast',
    nodeID: 'node-breakfast',
    kind: 'meal',
    start: 7 * 3600,
    end: 7 * 3600 + 1800,
  });
  const future = interval({
    id: 'future',
    nodeID: 'node-future',
    start: 12 * 3600,
    end: 13 * 3600,
  });

  const completed = evaluateAdaptiveRouteFreshness({
    dayPlan: plan([breakfast, future]),
    ledgerEntries: [{ intervalID: 'breakfast', status: 'completed', observedAt: '2026-09-03T12:00:00Z' }],
    nowSecond: 8 * 3600,
    progressSnapshot: { expectedDayFinish: 0.9 },
  });
  assert.equal(completed.shouldReroute, false);

  const skipped = evaluateAdaptiveRouteFreshness({
    dayPlan: plan([breakfast, future]),
    ledgerEntries: [{ intervalID: 'breakfast', status: 'skipped', observedAt: '2026-09-03T12:00:00Z' }],
    nowSecond: 8 * 3600,
    progressSnapshot: { expectedDayFinish: 0.9 },
  });
  assert.equal(skipped.shouldReroute, false);
});

test('uncompleted activity near the end of its window is marked at risk', () => {
  const workout = interval({
    id: 'workout',
    key: 'strength',
    nodeID: 'node-workout',
    kind: 'workout',
    start: 10 * 3600,
    end: 11 * 3600,
  });
  const lunch = interval({
    id: 'lunch',
    nodeID: 'node-lunch',
    kind: 'meal',
    start: 12 * 3600,
    end: 12 * 3600 + 1800,
  });

  const result = evaluateAdaptiveRouteFreshness({
    dayPlan: plan([workout, lunch]),
    nowSecond: 10 * 3600 + 52 * 60,
    atRiskWindowSeconds: 600,
    progressSnapshot: { expectedDayFinish: 0.9 },
  });

  assert.equal(result.shouldReroute, true);
  assert.equal(result.trigger, 'activity_window_at_risk');
  assert.equal(result.intervalID, 'workout');
  assert.equal(result.details.secondsRemaining, 8 * 60);
});

test('degraded expected finish triggers once per material fingerprint', () => {
  const first = interval({
    id: 'one',
    key: 'one',
    nodeID: 'node-one',
    start: 15 * 3600,
    end: 16 * 3600,
    probability: 0.35,
  });
  const second = interval({
    id: 'two',
    key: 'two',
    nodeID: 'node-two',
    start: 18 * 3600,
    end: 19 * 3600,
    probability: 0.30,
  });

  const initial = evaluateAdaptiveRouteFreshness({
    dayPlan: plan([first, second]),
    nowSecond: 14 * 3600,
    progressSnapshot: { expectedDayFinish: 0.52, expectedFinishPoints: 52 },
    minimumExpectedDayFinish: 0.60,
  });
  assert.equal(initial.shouldReroute, true);
  assert.equal(initial.trigger, 'expected_finish_degraded');

  const duplicate = evaluateAdaptiveRouteFreshness({
    dayPlan: plan([first, second]),
    nowSecond: 14 * 3600,
    progressSnapshot: { expectedDayFinish: 0.52, expectedFinishPoints: 52 },
    minimumExpectedDayFinish: 0.60,
    previousFingerprint: initial.fingerprint,
  });
  assert.equal(duplicate.shouldReroute, false);
  assert.equal(duplicate.reason, 'fresh_or_duplicate_trigger');
});

test('candidate rebuild drops elapsed activities and rebases the at-risk activity', () => {
  const missed = interval({
    id: 'missed',
    key: 'missed',
    nodeID: 'node-missed',
    start: 8 * 3600,
    end: 9 * 3600,
  });
  const current = interval({
    id: 'current',
    key: 'current-workout',
    nodeID: 'node-current',
    kind: 'workout',
    start: 10 * 3600,
    end: 11 * 3600,
  });
  const future = interval({
    id: 'future',
    key: 'future-meal',
    nodeID: 'node-future',
    kind: 'meal',
    start: 12 * 3600,
    end: 12 * 3600 + 1800,
  });
  const alternative = interval({
    id: 'alternative',
    key: 'future-alt',
    nodeID: 'node-alt',
    kind: 'meal',
    start: 12 * 3600,
    end: 12 * 3600 + 1800,
    group: 'future-meal',
  });

  const decisionSecond = 10 * 3600 + 55 * 60;
  const candidates = buildAdaptiveRerouteCandidates({
    dayPlan: plan([missed, current, future], [[alternative]]),
    decisionSecond,
    trigger: {
      trigger: 'activity_window_at_risk',
      intervalID: 'current',
      sourceNodeID: 'node-current',
    },
    maxShiftSeconds: 7200,
    rebaseBufferSeconds: 60,
  });

  assert.equal(candidates.some((candidate) => candidate.sourceNodeID === 'node-missed'), false);
  const rebased = candidates.find((candidate) => candidate.sourceNodeID === 'node-current');
  assert.ok(rebased);
  assert.equal(rebased.fixedStartSecond, null);
  assert.equal(rebased.earliestStartSecond, decisionSecond + 60);
  assert.equal(rebased.metadata.rebasedByFreshness, true);

  const futureCandidate = candidates.find((candidate) => candidate.sourceNodeID === 'node-future');
  assert.equal(futureCandidate.fixedStartSecond, 12 * 3600);
  assert.equal(futureCandidate.required, true);

  const alternativeCandidate = candidates.find((candidate) => candidate.sourceNodeID === 'node-alt');
  assert.ok(alternativeCandidate);
  assert.equal(alternativeCandidate.decisionGroup, 'future-meal');
  assert.equal(alternativeCandidate.required, true);
});
