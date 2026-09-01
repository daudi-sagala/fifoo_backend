import test from 'node:test';
import assert from 'node:assert/strict';
import { assertJSONByteSize, assertMatchingRevision, assertUUID, isUUID, parseEnvelope } from '../src/lib/validation.js';

const requestID = '11111111-1111-4111-8111-111111111111';
const nodeID = '22222222-2222-4222-8222-222222222222';

test('UUID validation accepts Swift rawValue wrappers', () => {
  assert.equal(isUUID(nodeID), true);
  assert.equal(assertUUID({ rawValue: nodeID }, 'nodeID'), nodeID);
});

test('request envelope normalizes Pass 5.37 context', () => {
  const parsed = parseEnvelope({
    context: {
      requestID,
      userID: 'client-hint-only',
      deviceID: 'ios-device',
      mapDate: '2026-08-29',
      timeZoneIdentifier: 'America/New_York',
      clientRevision: 7,
      sentAt: '2026-08-29T12:00:00Z',
    },
    payload: { nodeID: { rawValue: nodeID } },
  });
  assert.equal(parsed.context.requestID, requestID);
  assert.equal(parsed.context.mapDate, '2026-08-29');
  assert.equal(parsed.context.clientRevision, 7);
});

test('request envelope rejects impossible map dates and invalid time zones', () => {
  assert.throws(() => parseEnvelope({
    context: {
      requestID,
      userID: 'hint',
      deviceID: 'ios-device',
      mapDate: '2026-02-31',
      timeZoneIdentifier: 'America/New_York',
      clientRevision: 0,
    },
    payload: {},
  }));
  assert.throws(() => parseEnvelope({
    context: {
      requestID,
      userID: 'hint',
      deviceID: 'ios-device',
      mapDate: '2026-08-29',
      timeZoneIdentifier: 'Not/A_Timezone',
      clientRevision: 0,
    },
    payload: {},
  }));
});

test('optimistic concurrency accepts only the authoritative revision', () => {
  assert.equal(assertMatchingRevision(7, 7), 7);
  assert.throws(
    () => assertMatchingRevision(6, 7),
    (error) => error?.code === 'conflict' && error?.details?.serverRevision === 7,
  );
});

test('mutation payload byte limit rejects oversized JSON', () => {
  assert.equal(assertJSONByteSize({ text: 'ok' }, 100), 13);
  assert.throws(
    () => assertJSONByteSize({ text: 'x'.repeat(200) }, 32),
    (error) => error?.code === 'invalid_payload',
  );
});

