import test from 'node:test';
import assert from 'node:assert/strict';

import { activityEndDayOffset } from '../src/services/nodes.js';

test('activity end clock after start stays on the same day', () => {
  assert.equal(activityEndDayOffset(9 * 3600, 10 * 3600), 0);
});

test('activity end clock equal to start stays on the same day', () => {
  assert.equal(activityEndDayOffset(9 * 3600, 9 * 3600), 0);
});

test('activity end clock before start rolls into the next day', () => {
  assert.equal(
    activityEndDayOffset(23 * 3600 + 15 * 60, 15 * 60),
    1,
  );
});
