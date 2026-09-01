import test from 'node:test';
import assert from 'node:assert/strict';

import { latestPlayState } from '../src/services/play.js';

const userID = 'a12b3456-c789-4def-8123-456789abcdef';
const workoutID = '11111111-2222-4333-8444-555555555555';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.includes('FROM workout_sessions')) {
        return {
          rowCount: 1,
          rows: [{
            workout_session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            session_data: {
              id: workoutID,
              sourceWorkoutID: 'independent-upper-body',
              status: 'Paused',
            },
          }],
        };
      }
      if (sql.includes('FROM workout_session_live_messages')) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('targeted play restore selects the exact ActivityWorkout session and source workout', async () => {
  const client = fakeClient();
  const state = await latestPlayState(client, {
    userID,
    maxHistory: 100,
    workoutID,
    sourceWorkoutID: 'independent-upper-body',
  });

  assert.equal(state.workout.id, workoutID);
  assert.equal(state.workout.status, 'Paused');
  assert.match(client.calls[0].sql, /client_workout_id=\$2/);
  assert.match(client.calls[0].sql, /session_data->>'sourceWorkoutID'=\$3/);
  assert.deepEqual(client.calls[0].args, [userID, workoutID, 'independent-upper-body']);
});

test('generic play restore remains backward compatible and selects the latest session', async () => {
  const client = fakeClient();
  await latestPlayState(client, { userID, maxHistory: 100 });

  assert.doesNotMatch(client.calls[0].sql, /client_workout_id=/);
  assert.deepEqual(client.calls[0].args, [userID]);
});
