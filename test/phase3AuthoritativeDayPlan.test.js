import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadAuthoritativeDayPlanState,
  rerouteFutureDayPlan,
} from '../src/services/dayPlanning.js';
import { buildStandardWeightLossDay } from '../src/services/dailyPathGenerator.js';

const seededUserID = 'a12b3456-c789-4def-8123-456789abcdef';
const dayMapID = 'b12b3456-c789-4def-8123-456789abcdef';
const previousPlanID = 'c12b3456-c789-4def-8123-456789abcdef';
const newPlanID = 'd12b3456-c789-4def-8123-456789abcdef';

function completedEarnedPoints(graph, decisionSecond) {
  return graph.chosenPath.intervals
    .filter((interval) => interval.endSecond <= decisionSecond)
    .reduce((total, interval) => total + Number(interval.potentialPoints ?? 0), 0);
}

test('Phase 3 seeded flow refreshes state and future reroute preserves history + earned progress', async () => {
  const initial = buildStandardWeightLossDay({
    userID: seededUserID,
    mapDate: '2026-09-02',
  });
  const decisionSecond = 13 * 3600;
  const historicalEarned = completedEarnedPoints(initial.dayGraph, decisionSecond);
  const pathKinds = new Map();
  const insertedIntervals = [];
  let pathIndex = 0;
  let activeGraph = initial.dayGraph;
  let activePlanID = previousPlanID;
  let activeRevision = 1;
  let rerouteReason = null;
  let activatedAt = '2026-09-02T12:00:00.000Z';

  const client = {
    async query(sql, parameters = []) {
      if (sql.includes('SELECT plan_id,graph_data,algorithm_name')) {
        return {
          rowCount: 1,
          rows: [{
            plan_id: activePlanID,
            graph_data: activeGraph,
            algorithm_name: 'standard-weight-loss-day',
            algorithm_version: 1,
            rules_hash: initial.rulesHash,
          }],
        };
      }
      if (sql.includes('SELECT plan_id,plan_revision,graph_data,reroute_reason')) {
        return {
          rowCount: 1,
          rows: [{
            plan_id: activePlanID,
            plan_revision: activeRevision,
            graph_data: activeGraph,
            reroute_reason: rerouteReason,
            decision_second: decisionSecond,
            activated_at: activatedAt,
          }],
        };
      }
      if (sql.includes('COALESCE(MAX(plan_revision)')) {
        return { rowCount: 1, rows: [{ next_revision: activeRevision + 1 }] };
      }
      if (sql.includes('INSERT INTO day_plan_versions')) {
        activeRevision += 1;
        activePlanID = newPlanID;
        rerouteReason = parameters[12];
        activatedAt = '2026-09-02T13:00:00.000Z';
        return { rowCount: 1, rows: [{ plan_id: newPlanID, plan_revision: activeRevision }] };
      }
      if (sql.includes('INSERT INTO day_plan_paths')) {
        pathIndex += 1;
        const planPathID = `e12b3456-c789-4def-8123-456789abcde${pathIndex}`;
        pathKinds.set(planPathID, parameters[3]);
        return { rowCount: 1, rows: [{ plan_path_id: planPathID }] };
      }
      if (sql.includes('INSERT INTO day_plan_intervals')) {
        insertedIntervals.push({
          pathKind: pathKinds.get(parameters[1]),
          intervalID: parameters[2],
          sourceNodeID: parameters[3],
          key: parameters[4],
          kind: parameters[5],
          startSecond: Number(parameters[7]),
          endSecond: Number(parameters[8]),
          progressCategory: parameters[9],
          potentialPoints: Number(parameters[10]),
          plannedProgressStart: Number(parameters[11]),
          plannedProgressEnd: Number(parameters[12]),
          lifecycleStatus: parameters[13],
          completionEvaluator: JSON.parse(parameters[14]),
          metabolicContext: parameters[15],
          metadata: JSON.parse(parameters[16]),
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO day_plan_interval_lineage')) {
        return { rowCount: insertedIntervals.filter((row) => row.pathKind === 'completed').length, rows: [] };
      }
      if (sql.includes('WITH latest AS')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('SELECT plan_id,total_potential_points')) {
        return { rowCount: 1, rows: [{ plan_id: activePlanID, total_potential_points: 100 }] };
      }
      if (sql.includes('JOIN day_plan_paths p') && sql.includes("p.path_kind IN ('completed','chosen')")) {
        const source = insertedIntervals.length
          ? insertedIntervals.filter((row) => ['completed', 'chosen'].includes(row.pathKind))
          : initial.dayGraph.chosenPath.intervals.map((interval) => ({
              ...interval,
              intervalID: interval.intervalID,
              potentialPoints: Number(interval.potentialPoints ?? 0),
              metadata: {},
            }));
        return {
          rowCount: source.length,
          rows: source.map((row, index) => ({
            plan_interval_id: `f12b3456-c789-4def-8123-456789abcde${index}`,
            interval_id: row.intervalID,
            start_second: row.startSecond,
            end_second: row.endSecond,
            potential_points: row.potentialPoints,
            completion_evaluator: row.completionEvaluator ?? { type: 'binary' },
            interval_data: row.metadata ?? {},
            expected_progress: null,
          })),
        };
      }
      if (sql.includes('SELECT DISTINCT ON (l.plan_interval_id)')) {
        // Simulate already-earned immutable history. The snapshot should carry
        // this amount forward independent of the newly optimized future.
        return historicalEarned > 0
          ? {
              rowCount: 1,
              rows: [{
                entry_id: '11111111-1111-4111-8111-111111111111',
                interval_id: initial.dayGraph.chosenPath.intervals[0].intervalID,
                potential_points: historicalEarned,
                completion_score: 1,
                earned_points: historicalEarned,
                status: 'completed',
                reason_code: null,
                observed_at: '2026-09-02T12:59:00.000Z',
                supersedes_entry_id: null,
              }],
            }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM learning_outcome_observations')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO routing_decision_events')) {
        return { rowCount: 1, rows: [{ routing_decision_event_id: '01234567-89ab-4cde-8123-456789abcdef' }] };
      }
      if (sql.includes('INSERT INTO learning_decision_candidates')) {
        return { rowCount: 1, rows: [{ learning_decision_candidate_id: '11234567-89ab-4cde-8123-456789abcdef' }] };
      }
      if (sql.includes('INSERT INTO learning_decision_routes')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO learning_feature_snapshots')) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [{ day_map_id: dayMapID }] };
    },
  };

  const before = await loadAuthoritativeDayPlanState(client, {
    dayMap: { day_map_id: dayMapID, current_time_seconds: decisionSecond },
    nowSecond: decisionSecond,
  });
  assert.equal(before.planRevision, 1);
  assert.equal(before.dayPlan.schema, initial.dayGraph.schema);

  const futureCandidates = initial.dayGraph.chosenPath.intervals
    .filter((interval) => interval.startSecond >= decisionSecond && interval.sourceNodeID)
    .slice(0, 3)
    .map((interval, index) => ({
      key: interval.key,
      candidateKey: interval.candidateKey ?? interval.key,
      decisionGroup: interval.candidateKey ?? interval.key,
      kind: interval.intervalKind,
      sourceNodeID: interval.sourceNodeID,
      required: index !== 0, // the first seeded future activity is the skipped one
      earliestStartSecond: interval.startSecond,
      latestEndSecond: 86_400,
      durationSeconds: Math.max(1, interval.endSecond - interval.startSecond),
      progressCategory: interval.progressCategory,
      progressWeightHint: Math.max(0.001, Number(interval.progressWeightHint ?? interval.potentialPoints ?? 1)),
      hardExcluded: index === 0,
    }));

  // Equivalent to the client marking the first future activity skipped and
  // then emitting game:route:reroute from the durable mutation queue.
  const rerouted = await rerouteFutureDayPlan(client, {
    dayMap: { day_map_id: dayMapID },
    userID: seededUserID,
    mapDate: '2026-09-02',
    decisionSecond,
    candidates: futureCandidates,
    rerouteReason: 'skip',
    alternativeCount: 2,
  });
  activeGraph = rerouted.dayPlan;

  assert.equal(rerouted.dayPlan.completedPath.intervals.at(-1).endSecond, decisionSecond);
  assert.equal(rerouted.dayPlan.chosenPath.intervals[0].startSecond, decisionSecond);
  assert.equal(
    rerouted.dayPlan.completedPath.intervals.reduce((sum, interval) => sum + Number(interval.potentialPoints ?? 0), 0),
    rerouted.lockedPotentialPoints,
  );
  assert.equal(rerouted.progressSnapshot.earnedPoints, historicalEarned);

  const after = await loadAuthoritativeDayPlanState(client, {
    dayMap: { day_map_id: dayMapID, current_time_seconds: decisionSecond },
    nowSecond: decisionSecond,
  });
  assert.equal(after.planRevision, 2);
  assert.equal(after.rerouteReason, 'skip');
  assert.equal(after.progressSnapshot.earnedPoints, historicalEarned);
  assert.equal(after.dayPlan.completedPath.intervals.at(-1).endSecond, decisionSecond);
  assert.equal(after.dayPlan.chosenPath.intervals[0].startSecond, decisionSecond);
});
