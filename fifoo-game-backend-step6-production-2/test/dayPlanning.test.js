import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStandardWeightLossDay } from '../src/services/dailyPathGenerator.js';
import { persistCompiledDayPlan } from '../src/services/dayPlanning.js';

const userID = 'a12b3456-c789-4def-8123-456789abcdef';
const dayMapID = 'b12b3456-c789-4def-8123-456789abcdef';

test('compiled Day Graph persists as one version, one chosen path, and all intervals', async () => {
  const plan = buildStandardWeightLossDay({ userID, mapDate: '2026-09-01' });
  const calls = [];
  let pathCounter = 0;
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('COALESCE(MAX(plan_revision)')) return { rowCount: 1, rows: [{ next_revision: 1 }] };
      if (sql.includes('INSERT INTO day_plan_versions')) {
        return { rowCount: 1, rows: [{ plan_id: 'c12b3456-c789-4def-8123-456789abcdef', plan_revision: 1 }] };
      }
      if (sql.includes('INSERT INTO day_plan_paths')) {
        pathCounter += 1;
        return { rowCount: 1, rows: [{ plan_path_id: `d12b3456-c789-4def-8123-456789abcde${pathCounter}` }] };
      }
      return { rowCount: 1, rows: [{ day_map_id: dayMapID }] };
    },
  };

  const result = await persistCompiledDayPlan(client, {
    dayMap: { day_map_id: dayMapID },
    userID,
    mapDate: '2026-09-01',
    algorithmName: 'test-planner',
    algorithmVersion: 1,
    rulesHash: plan.rulesHash,
    chosenPath: plan.dayGraph.chosenPath,
  });

  assert.equal(result.planRevision, 1);
  assert.equal(result.totalPotentialPoints, 100);
  assert.equal(result.intervalCount, plan.dayGraph.chosenPath.intervals.length);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO day_plan_paths')).length, 1);
  assert.equal(
    calls.filter((call) => call.sql.includes('INSERT INTO day_plan_intervals')).length,
    plan.dayGraph.chosenPath.intervals.length,
  );
});

test('rerouted graph persists completed history and chosen future as separate primary paths', async () => {
  const plan = buildStandardWeightLossDay({ userID, mapDate: '2026-09-01' });
  const decisionSecond = 15 * 3600;
  const crossing = plan.dayGraph.chosenPath.intervals.find((interval) => (
    interval.startSecond < decisionSecond && interval.endSecond > decisionSecond
  ));
  const completedIntervals = plan.dayGraph.chosenPath.intervals
    .filter((interval) => interval.endSecond <= decisionSecond);
  const chosenIntervals = plan.dayGraph.chosenPath.intervals
    .filter((interval) => interval.startSecond >= decisionSecond);
  if (crossing) {
    const [left, right] = (await import('../src/algorithms/dayGraph.js')).splitIntervalAt(crossing, decisionSecond);
    completedIntervals.push({ ...left, potentialPoints: crossing.potentialPoints });
    chosenIntervals.unshift({ ...right, potentialPoints: 0 });
  }
  const completedPath = { ...plan.dayGraph.chosenPath, pathKey: 'completed', pathKind: 'completed', intervals: completedIntervals };
  const chosenPath = { ...plan.dayGraph.chosenPath, pathKey: 'chosen-future', intervals: chosenIntervals };
  const calls = [];
  let pathCounter = 0;
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes('COALESCE(MAX(plan_revision)')) return { rowCount: 1, rows: [{ next_revision: 2 }] };
      if (sql.includes('INSERT INTO day_plan_versions')) return { rowCount: 1, rows: [{ plan_id: 'c12b3456-c789-4def-8123-456789abcdef', plan_revision: 2 }] };
      if (sql.includes('INSERT INTO day_plan_paths')) {
        pathCounter += 1;
        return { rowCount: 1, rows: [{ plan_path_id: `d12b3456-c789-4def-8123-456789abcde${pathCounter}` }] };
      }
      return { rowCount: 1, rows: [{ day_map_id: dayMapID }] };
    },
  };
  const result = await persistCompiledDayPlan(client, {
    dayMap: { day_map_id: dayMapID }, userID, mapDate: '2026-09-01',
    algorithmName: 'test-planner', algorithmVersion: 2, rulesHash: 'reroute-test',
    completedPath, chosenPath, parentPlanID: 'e12b3456-c789-4def-8123-456789abcdef',
    decisionSecond, lockedPotentialPoints: completedIntervals.reduce((sum, item) => sum + item.potentialPoints, 0),
  });
  assert.equal(result.totalPotentialPoints, 100);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO day_plan_paths')).length, 2);
});
