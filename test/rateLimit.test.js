import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenWindow } from '../src/http/rateLimit.js';

test('token-window limiter blocks after the configured count', () => {
  const limiter = createTokenWindow({ name: `test-${Date.now()}`, limit: 2, windowMs: 60_000 });
  assert.equal(limiter.consume('same-user').allowed, true);
  assert.equal(limiter.consume('same-user').allowed, true);
  const blocked = limiter.consume('same-user');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
});

test('token-window limiter isolates subjects', () => {
  const limiter = createTokenWindow({ name: `test-subject-${Date.now()}`, limit: 1, windowMs: 60_000 });
  assert.equal(limiter.consume('user-a').allowed, true);
  assert.equal(limiter.consume('user-a').allowed, false);
  assert.equal(limiter.consume('user-b').allowed, true);
});
