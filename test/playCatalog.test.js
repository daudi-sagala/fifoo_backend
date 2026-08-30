import test from 'node:test';
import assert from 'node:assert/strict';

import { listPlayableWorkoutTemplates, persistWorkoutSnapshot } from '../src/services/play.js';

const userID = 'a12b3456-c789-4def-8123-456789abcdef';
const definitionID = '11111111-2222-4333-8444-555555555555';
const exerciseID = '22222222-3333-4444-8555-666666666666';
const sessionID = '33333333-4444-4555-8666-777777777777';

test('play workout catalog maps active PostgreSQL definitions into Swift-decodable Workout templates', async () => {
  const client = {
    async query(sql, args) {
      assert.match(sql, /FROM workouts w/);
      assert.deepEqual(args, [userID]);
      return {
        rows: [{
          workout_id: definitionID,
          title: 'Beginner Strength',
          description: 'A simple workout.',
          workout_duration_seconds: 900,
          workout_categories: ['Strength'],
          workout_format: 'Independent',
          workout_main_image_url: null,
          workout_image_urls: [],
          created_at: new Date('2026-08-29T12:00:00Z'),
          exercise_id: exerciseID,
          exercise_order: 1,
          sets: 3,
          reps: 10,
          assignment_duration_seconds: 60,
          min_duration_in_seconds: 30,
          exercise_instructions: {
            demoVideoUrl: null,
            steps: ['Move with control.', 'Finish the planned reps.'],
          },
          exercise_title: 'Bodyweight Squat',
          exercise_main_image_url: 'https://example.com/squat.jpg',
          exercise_duration_seconds: 45,
          exercise_categories: ['Strength', 'Lower Body'],
          exercise_description: 'Squat with control.',
          distance_in_miles: null,
          weight: null,
          equipment: [],
          exercise_image_urls: [],
          exercise_video_urls: [],
        }],
      };
    },
  };

  const workouts = await listPlayableWorkoutTemplates(client, { userID });
  assert.equal(workouts.length, 1);
  const workout = workouts[0];
  assert.equal(workout.id, definitionID);
  assert.equal(workout.sourceWorkoutID, definitionID);
  assert.equal(workout.status, 'Not Started');
  assert.equal(workout.exercises.length, 1);
  assert.equal(workout.exercises[0].exerciseId, exerciseID);
  assert.equal(workout.exercises[0].exerciseCategory, 'strength');
  assert.equal(workout.exercises[0].durationUnit, 'seconds');
  assert.equal(workout.exercises[0].media.mediaType, 'image');
  assert.equal(workout.exercises[0].instructions.steps.length, 2);
});

test('persisted standalone Play session retains source workout definition separately from the fresh session ID', async () => {
  const calls = [];
  const client = {
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.includes('INSERT INTO workouts')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO workout_sessions')) {
        return {
          rowCount: 1,
          rows: [{ workout_session_id: '44444444-5555-4666-8777-888888888888' }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const workout = {
    id: sessionID,
    sourceWorkoutID: definitionID,
    sourceActivityNodeID: null,
    name: 'Beginner Strength',
    description: 'A simple workout.',
    exercises: [],
    status: 'Not Started',
    startedAt: null,
    endedAt: null,
    pausedAt: null,
    resumedAt: null,
    pausePeriods: [],
    currentWorkoutExerciseID: null,
    totalSteps: 0,
    totalPedometerDistanceMeters: 0,
    totalFloorsAscended: 0,
    totalFloorsDescended: 0,
    createdAt: '2026-08-29T12:00:00Z',
    updatedAt: '2026-08-29T12:00:00Z',
  };

  await persistWorkoutSnapshot(client, { userID, workout });

  assert.equal(calls[0].args[0], definitionID);
  const sessionInsert = calls[1];
  assert.equal(sessionInsert.args[5], definitionID); // workout_sessions.workout_id
  assert.equal(sessionInsert.args[8], sessionID); // workout_sessions.client_workout_id
});
