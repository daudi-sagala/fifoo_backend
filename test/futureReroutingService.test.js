import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStandardWeightLossDay } from '../src/services/dailyPathGenerator.js';
import { rerouteFutureDayPlan } from '../src/services/dayPlanning.js';

const userID = 'a12b3456-c789-4def-8123-456789abcdef';
const dayMapID = 'b12b3456-c789-4def-8123-456789abcdef';
const previousPlanID = 'c12b3456-c789-4def-8123-456789abcdef';
const newPlanID = 'd12b3456-c789-4def-8123-456789abcdef';

test('reroute service publishes one atomic child revision and carries the completed prefix', async () => {
  const initial = buildStandardWeightLossDay({ userID, mapDate: '2026-09-01' });
  const pathKinds = new Map();
  const insertedIntervals = [];
  const calls = [];
  let pathIndex = 0;
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('SELECT plan_id,graph_data,algorithm_name')) {
        return {
          rowCount: 1,
          rows: [{
            plan_id: previousPlanID,
            graph_data: initial.dayGraph,
            algorithm_name: 'standard-weight-loss-day',
            algorithm_version: 1,
            rules_hash: initial.rulesHash,
          }],
        };
      }
      if (sql.includes('COALESCE(MAX(plan_revision)')) {
        return { rowCount: 1, rows: [{ next_revision: 2 }] };
      }
      if (sql.includes('INSERT INTO day_plan_versions')) {
        return { rowCount: 1, rows: [{ plan_id: newPlanID, plan_revision: 2 }] };
      }
      if (sql.includes('INSERT INTO day_plan_paths')) {
        pathIndex += 1;
        const pathID = `e12b3456-c789-4def-8123-456789abcde${pathIndex}`;
        pathKinds.set(pathID, parameters[3]);
        return { rowCount: 1, rows: [{ plan_path_id: pathID }] };
      }
      if (sql.includes('INSERT INTO day_plan_intervals')) {
        insertedIntervals.push({
          pathKind: pathKinds.get(parameters[1]),
          intervalID: parameters[2],
          startSecond: Number(parameters[7]),
          endSecond: Number(parameters[8]),
          potentialPoints: Number(parameters[10]),
          intervalData: JSON.parse(parameters[16]),
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO day_plan_interval_lineage')) {
        return { rowCount: insertedIntervals.filter((row) => row.pathKind === 'completed').length, rows: [] };
      }
      if (sql.includes('WITH latest AS')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT plan_id,total_potential_points')) {
        return { rowCount: 1, rows: [{ plan_id: newPlanID, total_potential_points: 100 }] };
      }
      if (sql.includes("p.path_kind IN ('completed','chosen')")) {
        return {
          rowCount: insertedIntervals.length,
          rows: insertedIntervals
            .filter((row) => ['completed', 'chosen'].includes(row.pathKind))
            .map((row, index) => ({
              plan_interval_id: `f12b3456-c789-4def-8123-456789abcde${index}`,
              interval_id: row.intervalID,
              start_second: row.startSecond,
              end_second: row.endSecond,
              potential_points: row.potentialPoints,
              completion_evaluator: { type: 'binary' },
              interval_data: row.intervalData,
              expected_progress: null,
            })),
        };
      }
      if (sql.includes('SELECT DISTINCT ON (l.plan_interval_id)')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ day_map_id: dayMapID }] };
    },
  };

  const decisionSecond = 14 * 3600 + 37 * 60 + 22;
  const result = await rerouteFutureDayPlan(client, {
    dayMap: { day_map_id: dayMapID },
    userID,
    mapDate: '2026-09-01',
    decisionSecond,
    candidates: [
      {
        key: 'walk', decisionGroup: 'exercise', kind: 'movement', required: true,
        fixedStartSecond: 17 * 3600, durationMinutes: 30,
        progressCategory: 'movement', progressWeightHint: 12,
      },
      {
        key: 'home-workout', decisionGroup: 'exercise', kind: 'workout', required: true,
        fixedStartSecond: 17 * 3600, durationMinutes: 40,
        progressCategory: 'exercise', progressWeightHint: 18,
      },
      {
        key: 'dinner', decisionGroup: 'dinner', kind: 'meal', required: true,
        fixedStartSecond: 19 * 3600, durationMinutes: 30,
        progressCategory: 'nutrition', progressWeightHint: 10,
      },
    ],
    alternativeCount: 1,
  });

  assert.equal(result.planRevision, 2);
  assert.equal(result.decisionSecond, decisionSecond);
  assert.equal(result.dayPlan.completedPath.intervals.at(-1).endSecond, decisionSecond);
  assert.equal(result.dayPlan.chosenPath.intervals[0].startSecond, decisionSecond);
  assert.equal(result.lockedPotentialPoints + result.remainingPotentialPoints, 100);
  assert.ok(calls.some((call) => (
    call.sql.includes('INSERT INTO day_plan_versions') && call.parameters[11] === previousPlanID
  )));
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO day_plan_interval_lineage')));
});
