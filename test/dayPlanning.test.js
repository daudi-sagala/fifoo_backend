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

