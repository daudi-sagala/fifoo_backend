import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEARNING_FEATURE_SCHEMA_VERSION,
  LEARNING_POLICY_VERSION,
  buildBehavioralFeatureSnapshot,
  captureLearningOutcome,
  captureRoutingDecision,
  normalizeCandidateObservation,
  pseudonymousUserKey,
  routeObservation,
  sanitizeLearningContext,
} from '../src/services/learningData.js';
import { optimizeDayRoutes } from '../src/algorithms/routingEngine.js';

const userID = 'a12b3456-c789-4def-8123-456789abcdef';
const dayMapID = 'b12b3456-c789-4def-8123-456789abcdef';
const planID = 'c12b3456-c789-4def-8123-456789abcdef';
const decisionEventID = 'd12b3456-c789-4def-8123-456789abcdef';
const candidateID = 'e12b3456-c789-4def-8123-456789abcdef';

test('learning context is data-minimized and omits free-form/user text', () => {
  const sanitized = sanitizeLearningContext({
    mode: 'cold-start',
    timeZoneIdentifier: 'America/New_York',
    defaultTransitionSeconds: 300,
    availabilityWindows: [{ startSecond: 10, endSecond: 20 }],
    hardBusyIntervals: [{ startSecond: 30, endSecond: 40 }],
    title: 'private title',
    note: 'private note',
    address: 'private address',
    message: 'private message',
  });
  assert.equal(sanitized.mode, 'cold-start');
  assert.equal(sanitized.timeZoneIdentifier, 'America/New_York');
  assert.deepEqual(sanitized.availabilityWindows, [{ startSecond: 10, endSecond: 20 }]);
  assert.equal('title' in sanitized, false);
  assert.equal('note' in sanitized, false);
  assert.equal('address' in sanitized, false);
  assert.equal('message' in sanitized, false);
});

test('behavioral feature snapshot is point-in-time and contains useful aggregates', async () => {
  const observedRows = [
    {
      interval_kind: 'workout', scheduled_start_second: 8 * 3600,
      completion_score: 1, actual_status: 'completed', potential_points: 10, earned_points: 10,
      observed_at: '2026-09-01T12:00:00.000Z',
    },
    {
      interval_kind: 'meal', scheduled_start_second: 13 * 3600,
      completion_score: 0, actual_status: 'skipped', potential_points: 8, earned_points: 0,
      observed_at: '2026-09-01T17:00:00.000Z',
    },
  ];
  let queryText = '';
  const client = {
    async query(sql, parameters) {
      queryText = sql;
      assert.equal(parameters[0], userID);
      assert.equal(parameters[1], '2026-09-02T10:00:00.000Z');
      return { rowCount: observedRows.length, rows: observedRows };
    },
  };
  const snapshot = await buildBehavioralFeatureSnapshot(client, {
    userID,
    asOf: '2026-09-02T10:00:00.000Z',
  });
  assert.match(queryText, /observed_at < \$2::timestamptz/);
  assert.equal(snapshot.featureSchemaVersion, LEARNING_FEATURE_SCHEMA_VERSION);
  assert.equal(snapshot.sampleCount, 2);
  assert.equal(snapshot.featureData.allTime.completionRate, 0.5);
  assert.equal(snapshot.featureData.allTime.skipRate, 0.5);
  assert.equal(snapshot.featureData.byKind.workout.completionRate, 1);
  assert.equal(snapshot.featureData.byTimeBucket.morning.sampleCount, 1);
});

test('optimizer exposes every candidate considered plus the route exposures', () => {
  const result = optimizeDayRoutes({
    candidates: [
      {
        key: 'walk', decisionGroup: 'exercise', kind: 'movement', required: true,
        fixedStartSecond: 10 * 3600, durationSeconds: 1800,
        progressCategory: 'movement', progressWeightHint: 10,
      },
      {
        key: 'workout', decisionGroup: 'exercise', kind: 'workout', required: true,
        fixedStartSecond: 10 * 3600, durationSeconds: 1800,
        progressCategory: 'exercise', progressWeightHint: 15,
      },
      {
        key: 'lunch', decisionGroup: 'lunch', kind: 'meal', required: true,
        fixedStartSecond: 13 * 3600, durationSeconds: 1800,
        progressCategory: 'nutrition', progressWeightHint: 10,
      },
    ],
    context: { idSeed: 'phase4-learning-test' },
    alternativeCount: 1,
  });
  assert.equal(result.candidateObservations.length, 3);
  assert.ok(result.candidateObservations.some((candidate) => candidate.selectedByChosenRoute));
  assert.ok(result.candidateObservations.every((candidate) => (
    Number.isFinite(candidate.predictedCompletionProbability)
  )));
  assert.ok(result.routeObservations.length >= 1);
  assert.equal(result.routeObservations[0].wasSelected, true);
});

test('routing decision capture stores point-in-time context, all candidates, routes and feature snapshot', async () => {
  const calls = [];
  let candidateCounter = 0;
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM learning_outcome_observations')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO routing_decision_events')) {
        return { rowCount: 1, rows: [{ routing_decision_event_id: decisionEventID }] };
      }
      if (sql.includes('INSERT INTO learning_decision_candidates')) {
        candidateCounter += 1;
        return { rowCount: 1, rows: [{ learning_decision_candidate_id: `${candidateID.slice(0, -1)}${candidateCounter}` }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const candidates = [
    normalizeCandidateObservation({
      key: 'walk', decisionGroup: 'exercise', kind: 'movement', sourceNodeID: null,
      completionProbability: 0.72, selectedByChosenRoute: true, durationSeconds: 1200,
    }, 0),
    normalizeCandidateObservation({
      key: 'workout', decisionGroup: 'exercise', kind: 'workout', sourceNodeID: null,
      completionProbability: 0.51, selectedByChosenRoute: false, durationSeconds: 1800,
    }, 1),
  ];
  const routes = [routeObservation({
    pathKey: 'chosen', routeScore: 1.2, expectedProgress: 62,
    selectedCandidateKeys: ['walk'], intervals: [],
  }, 0, { selected: true, routeKind: 'chosen' })];

  const result = await captureRoutingDecision(client, {
    planID,
    planRevision: 2,
    dayMap: { day_map_id: dayMapID },
    userID,
    mapDate: '2026-09-02',
    timeZoneIdentifier: 'America/New_York',
    decisionType: 'future_reroute',
    decisionSecond: 45_000,
    rerouteReason: 'skip',
    algorithmName: 'fifoo-deterministic-router',
    algorithmVersion: 2,
    rulesHash: 'rules-v1',
    predictionMode: 'cold-start',
    routingContext: { mode: 'cold-start', note: 'must not be persisted' },
    progressSnapshot: { earnedPoints: 25 },
    requestID: 'f12b3456-c789-4def-8123-456789abcdef',
    occurredAt: '2026-09-02T13:00:00.000Z',
    candidates,
    routes,
  });

  assert.equal(result.decisionEventID, decisionEventID);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO learning_decision_candidates')).length, 2);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO learning_decision_routes')).length, 1);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO learning_feature_snapshots')).length, 1);
  const decisionInsert = calls.find((call) => call.sql.includes('INSERT INTO routing_decision_events'));
  const context = JSON.parse(decisionInsert.parameters[20]);
  assert.equal(context.note, undefined);
  assert.ok(context.behavioralFeatures);
  assert.equal(decisionInsert.parameters[14], 'completion-prior-blend');
  assert.equal(decisionInsert.parameters[15], 1);
  assert.equal(decisionInsert.parameters[16], LEARNING_FEATURE_SCHEMA_VERSION);
  assert.equal(decisionInsert.parameters[17], LEARNING_POLICY_VERSION);
});

test('progress outcome becomes append-only learning outcome linked to its decision candidate', async () => {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('FROM routing_decision_events')) {
        return { rowCount: 1, rows: [{ routing_decision_event_id: decisionEventID }] };
      }
      if (sql.includes('FROM learning_decision_candidates')) {
        return { rowCount: 1, rows: [{ learning_decision_candidate_id: candidateID }] };
      }
      if (sql.includes('FROM learning_outcome_observations') && sql.includes('ledger_entry_id=$1')) {
        return { rowCount: 1, rows: [{ learning_outcome_observation_id: '01234567-89ab-4def-8123-456789abcdef' }] };
      }
      if (sql.includes('INSERT INTO learning_outcome_observations')) {
        return { rowCount: 1, rows: [{ learning_outcome_observation_id: '11234567-89ab-4def-8123-456789abcdef' }] };
      }
      if (sql.includes('FROM learning_outcome_observations')) {
        return {
          rowCount: 1,
          rows: [{
            interval_kind: 'workout', scheduled_start_second: 36_000, completion_score: 0.5,
            actual_status: 'partiallyCompleted', potential_points: 20, earned_points: 10,
            observed_at: '2026-09-02T14:00:00.000Z',
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const result = await captureLearningOutcome(client, {
    ledgerEntryID: '21234567-89ab-4def-8123-456789abcdef',
    supersedesLedgerEntryID: '31234567-89ab-4def-8123-456789abcdef',
    planID,
    planIntervalID: '41234567-89ab-4def-8123-456789abcdef',
    userID,
    candidateKey: 'workout',
    intervalKind: 'workout',
    startSecond: 36_000,
    endSecond: 37_800,
    status: 'partiallyCompleted',
    completionScore: 0.5,
    potentialPoints: 20,
    earnedPoints: 10,
    reasonCode: 'user_stopped_early',
    evidence: { source: 'test' },
    observedAt: '2026-09-02T14:00:00.000Z',
  });
  assert.equal(result.decisionEventID, decisionEventID);
  assert.equal(result.candidateID, candidateID);
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO learning_outcome_observations')));
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO user_routing_profiles')));
});

test('learning export user key is stable, secret-dependent and never the raw UUID', () => {
  const first = pseudonymousUserKey(userID, 'secret-a');
  const second = pseudonymousUserKey(userID, 'secret-a');
  const differentSecret = pseudonymousUserKey(userID, 'secret-b');
  assert.equal(first, second);
  assert.notEqual(first, differentSecret);
  assert.notEqual(first, userID);
  assert.equal(first.length, 64);
});
