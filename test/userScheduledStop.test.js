import test from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateFromUserAddedNode,
  candidatesIncludingUserAddedNode,
  futureCandidatesFromDayPlan,
} from '../src/services/userScheduledStop.js';

function node({ id = '11111111-1111-4111-8111-111111111111', second = 14 * 3600, type = 'task', duration = 0 } = {}) {
  return {
    id: { rawValue: id },
    time: { secondsFromMidnight: second },
    placement: { coordinate: { _0: { time: { secondsFromMidnight: second }, progress: { percent: 42 } } } },
    isEnabled: true,
    content: {
      activity: {
        _0: {
          activityID: '22222222-2222-4222-8222-222222222222',
          activityType: type,
          title: 'User stop',
          endTime: '',
          workout: type === 'workout' ? { durationInSeconds: duration } : null,
        },
      },
    },
  };
}

test('user-added meal becomes a required fixed scheduling candidate', () => {
  const candidate = candidateFromUserAddedNode(node({ type: 'meal' }), 12 * 3600);
  assert.equal(candidate.kind, 'meal');
  assert.equal(candidate.required, true);
  assert.equal(candidate.fixedStartSecond, 14 * 3600);
  assert.equal(candidate.latestEndSecond, 14 * 3600 + 1800);
  assert.equal(candidate.progressCategory, 'nutrition');
  assert.equal(candidate.metadata.userScheduled, true);
});

test('user-added workout uses its selected duration', () => {
  const candidate = candidateFromUserAddedNode(node({ type: 'workout', duration: 3600 }), 12 * 3600);
  assert.equal(candidate.durationSeconds, 3600);
  assert.equal(candidate.progressCategory, 'exercise');
});

test('past additions are not converted into future route candidates while boundary-time additions are allowed', () => {
  assert.equal(candidateFromUserAddedNode(node({ second: 10 * 3600 }), 12 * 3600), null);
  assert.equal(candidateFromUserAddedNode(node({ second: 12 * 3600 }), 12 * 3600)?.fixedStartSecond, 12 * 3600);
});

test('existing future Day Graph activities remain candidates while fillers are ignored', () => {
  const dayPlan = {
    chosenPath: {
      intervals: [
        { key: 'fast', intervalKind: 'fasting', startSecond: 12 * 3600, endSecond: 13 * 3600, sourceNodeID: null },
        { key: 'lunch', intervalKind: 'meal', startSecond: 13 * 3600, endSecond: 13 * 3600 + 1800,
          sourceNodeID: '33333333-3333-4333-8333-333333333333', potentialPoints: 8, progressCategory: 'nutrition' },
      ],
    },
  };
  const candidates = futureCandidatesFromDayPlan(dayPlan, 12 * 3600);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceNodeID, '33333333-3333-4333-8333-333333333333');
});

test('new user stop is added once to the reroute candidate pool', () => {
  const added = node();
  const dayPlan = {
    chosenPath: {
      intervals: [{
        key: 'old', intervalKind: 'task', startSecond: 13 * 3600, endSecond: 13 * 3600 + 1200,
        sourceNodeID: '44444444-4444-4444-8444-444444444444', potentialPoints: 3, progressCategory: 'habits',
      }],
    },
  };
  const candidates = candidatesIncludingUserAddedNode({ dayPlan, node: added, decisionSecond: 12 * 3600 });
  assert.equal(candidates.length, 2);
  assert.equal(candidates.at(-1).sourceNodeID, added.id.rawValue);
});
