import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeKind, nodeTimeSeconds, nodeProgressPercent } from '../src/lib/nodeCodec.js';
import { parseClockSeconds } from '../src/lib/validation.js';

const uuid = '11111111-1111-4111-8111-111111111111';

test('decodes Swift synthesized activity enum envelope', () => {
  const node = {
    id: { rawValue: uuid },
    time: { secondsFromMidnight: 3600 },
    placement: { coordinate: { _0: { time: { secondsFromMidnight: 3600 }, progress: { percent: 42 } } } },
    content: { activity: { _0: { activityType: 'meal' } } },
    isEnabled: true,
  };
  assert.equal(nodeKind(node), 'activityMeal');
  assert.equal(nodeTimeSeconds(node), 3600);
  assert.equal(nodeProgressPercent(node), 42);
});

test('clamps end-of-day Swift time to PostgreSQL projection range', () => {
  assert.equal(nodeTimeSeconds({ time: { secondsFromMidnight: 86400 } }), 86399);
});

test('parses Activity wall-clock strings', () => {
  assert.equal(parseClockSeconds('12:00 AM'), 0);
  assert.equal(parseClockSeconds('1:30 PM'), 13 * 3600 + 30 * 60);
  assert.equal(parseClockSeconds('23:15'), 23 * 3600 + 15 * 60);
});

test('server can enforce a durable activity status from the mutation action', async () => {
  const { withActivityStatus } = await import('../src/lib/nodeCodec.js');
  const node = {
    id: { rawValue: uuid },
    content: { activity: { _0: { activityType: 'meal', status: 'Planned' } } },
  };
  assert.equal(withActivityStatus(node, 'skip').content.activity._0.status, 'Skipped');
  assert.equal(withActivityStatus(node, 'complete').content.activity._0.status, 'Completed');
  assert.equal(node.content.activity._0.status, 'Planned');
});
