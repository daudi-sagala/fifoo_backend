import { randomUUID } from 'node:crypto';
import { GameError } from '../lib/errors.js';
import { assertObject, assertString, assertUUID, isUUID, optionalUUID } from '../lib/validation.js';
import { stableUUID } from '../lib/stableUUID.js';


const SWIFT_EQUIPMENT = new Map([
  ['none', 'none'],
  ['barbell', 'barbell'],
  ['dumbbell', 'dumbbell'],
  ['kettlebell', 'kettlebell'],
  ['resistanceband', 'resistanceBand'],
  ['cable', 'cable'],
  ['machine', 'machine'],
  ['bench', 'bench'],
  ['pullupbar', 'pullUpBar'],
  ['medicineball', 'medicineBall'],
  ['stabilityball', 'stabilityBall'],
  ['treadmill', 'treadmill'],
  ['bicycle', 'bicycle'],
  ['rowingmachine', 'rowingMachine'],
  ['jumprope', 'jumpRope'],
]);

function compactKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function swiftExerciseCategory(values) {
  const terms = (Array.isArray(values) ? values : []).map((value) => String(value).toLowerCase());
  const includes = (term) => terms.some((value) => value.includes(term));
  if (includes('cardio') || includes('walk') || includes('run')) return 'cardio';
  if (includes('mobility')) return 'mobility';
  if (includes('flexib')) return 'flexibility';
  if (includes('balance')) return 'balance';
  if (includes('plyo')) return 'plyometric';
  if (includes('warm')) return 'warmup';
  if (includes('cool')) return 'cooldown';
  if (includes('rehab')) return 'rehabilitation';
  return 'strength';
}

function swiftEquipment(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const mapped = SWIFT_EQUIPMENT.get(compactKey(value));
    if (mapped && !result.includes(mapped)) result.push(mapped);
  }
  return result;
}

function iso(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function exerciseMedia(row) {
  const videos = Array.isArray(row.exercise_video_urls) ? row.exercise_video_urls : [];
  const images = Array.isArray(row.exercise_image_urls) ? row.exercise_image_urls : [];
  const video = videos.find(Boolean);
  if (video) return { mediaType: 'video', url: String(video) };
  const image = row.exercise_main_image_url || images.find(Boolean);
  if (image) return { mediaType: 'image', url: String(image) };
  return null;
}

function exerciseInstructions(raw, workoutIDValue, exerciseIDValue, order) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values = Array.isArray(raw.steps) ? raw.steps : [];
  const steps = values.map((step, index) => {
    const source = typeof step === 'string' ? { instruction: step } : (step ?? {});
    return {
      id: stableUUID(`play-catalog-instruction:${workoutIDValue}:${exerciseIDValue}:${order}:${index}`),
      stepNumber: Number(source.stepNumber ?? index + 1),
      instruction: String(source.instruction ?? source.text ?? source.title ?? '').trim() || `Step ${index + 1}`,
      detail: source.detail == null ? null : String(source.detail),
      imageURL: source.imageURL ?? source.imageUrl ?? null,
      videoURL: source.videoURL ?? source.videoUrl ?? null,
    };
  });
  const demo = raw.demoVideoURL ?? raw.demoVideoUrl ?? null;
  if (!demo && !steps.length) return null;
  return { demoVideoURL: demo, steps };
}

/**
 * Returns authenticated, user-accessible independent workout definitions as
 * fully decodable Swift Workout templates. A template ID is the reusable
 * workouts.workout_id. iOS replaces it with a fresh session UUID when the
 * user chooses the workout, while retaining this ID in sourceWorkoutID.
 */
export async function listPlayableWorkoutTemplates(client, { userID }) {
  const result = await client.query(
    `SELECT
       w.workout_id::text,w.title,w.description,w.duration_in_seconds AS workout_duration_seconds,
       w.workout_categories,w.workout_format,w.workout_main_image_url,w.workout_image_urls,w.created_at,
       we.exercise_id::text,we.exercise_order,we.sets,we.reps,
       we.duration_in_seconds AS assignment_duration_seconds,
       we.min_duration_in_seconds,we.exercise_instructions,
       e.title AS exercise_title,e.exercise_main_image_url,e.duration_in_seconds AS exercise_duration_seconds,
       e.exercise_categories,e.description AS exercise_description,e.distance_in_miles,e.weight,e.equipment,
       e.exercise_image_urls,e.exercise_video_urls
     FROM workouts w
     LEFT JOIN workouts_exercises we ON we.workout_id=w.workout_id AND COALESCE(we.is_enabled,TRUE)=TRUE
     LEFT JOIN exercises e ON e.exercise_id=we.exercise_id AND COALESCE(e.exercise_status,'active')='active'
     WHERE COALESCE(w.workout_status,'active')='active'
       AND (w.created_by=$1 OR w.created_by IS NULL)
       AND LOWER(COALESCE(w.workout_format,'independent')) NOT LIKE '%class%'
       AND LOWER(COALESCE(w.workout_format,'independent')) NOT LIKE '%guided%'
     ORDER BY w.title,COALESCE(we.exercise_order,2147483647),we.exercise_id`,
    [userID],
  );

  const grouped = new Map();
  for (const row of result.rows) {
    let workout = grouped.get(row.workout_id);
    if (!workout) {
      workout = {
        id: row.workout_id,
        sourceWorkoutID: row.workout_id,
        sourceActivityNodeID: null,
        name: String(row.title ?? 'Workout'),
        description: row.description ?? null,
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
        createdAt: iso(row.created_at),
        updatedAt: iso(row.created_at),
      };
      grouped.set(row.workout_id, workout);
    }

    if (!row.exercise_id || !row.exercise_title) continue;
    const order = Number(row.exercise_order ?? workout.exercises.length + 1);
    const duration = row.assignment_duration_seconds ?? row.exercise_duration_seconds ?? null;
    const category = swiftExerciseCategory(row.exercise_categories);
    const distance = row.distance_in_miles == null ? null : Number(row.distance_in_miles);
    const weight = row.weight == null ? null : Number(row.weight);
    const categories = Array.isArray(row.exercise_categories) ? row.exercise_categories.map(String) : [];
    const tracksSteps = category === 'cardio' && categories.some((value) => /walk|run|cardio/i.test(value));

    workout.exercises.push({
      exerciseId: row.exercise_id,
      workoutExerciseId: stableUUID(`play-catalog-assignment:${row.workout_id}:${row.exercise_id}:${order}`),
      name: String(row.exercise_title),
      media: exerciseMedia(row),
      exerciseCategory: category,
      equipment: swiftEquipment(row.equipment),
      sets: row.sets == null ? null : Number(row.sets),
      reps: row.reps == null ? null : Number(row.reps),
      duration: duration == null ? null : Number(duration),
      durationUnit: duration == null ? null : 'seconds',
      minDuration: row.min_duration_in_seconds == null ? null : Number(row.min_duration_in_seconds),
      distance,
      distanceUnit: distance == null ? null : 'miles',
      status: 'Not Started',
      weight,
      tracksSteps,
      targetSteps: null,
      stepsCompleted: 0,
      pedometerDistanceMeters: 0,
      floorsAscended: 0,
      floorsDescended: 0,
      averageCadence: null,
      averagePace: null,
      startedAt: null,
      pausedAt: null,
      resumedAt: null,
      completedAt: null,
      pausePeriods: [],
      instructions: exerciseInstructions(row.exercise_instructions, row.workout_id, row.exercise_id, order),
      isWorkoutBreak: null,
      description: row.exercise_description ?? null,
    });
  }

  return [...grouped.values()].filter((workout) => workout.exercises.length > 0);
}

function workoutID(workout) {
  return assertUUID(workout?.id, 'workout.id');
}

function workoutDurationSeconds(workout) {
  if (!Array.isArray(workout?.exercises)) return null;
  let total = 0;
  let has = false;
  for (const exercise of workout.exercises) {
    const value = Number(exercise.duration);
    if (!Number.isFinite(value)) continue;
    const unit = exercise.durationUnit;
    total += unit === 'hours' ? value * 3600 : unit === 'minutes' ? value * 60 : value;
    has = true;
  }
  return has ? Math.max(0, Math.round(total)) : null;
}

async function ensureWorkoutDefinition(client, { workout, userID }) {
  const sessionID = workoutID(workout);
  const sourceID = typeof workout?.sourceWorkoutID === 'string' && isUUID(workout.sourceWorkoutID)
    ? workout.sourceWorkoutID
    : sessionID;
  await client.query(
    `INSERT INTO workouts
      (workout_id,title,duration_in_seconds,workout_categories,description,workout_status,workout_format,created_by,workout_image_urls,tags)
     VALUES ($1,$2,$3,'{}'::text[],$4,$5,'Independent',$6,'{}'::text[],'{}'::text[])
     ON CONFLICT(workout_id) DO UPDATE SET
       title=EXCLUDED.title,duration_in_seconds=EXCLUDED.duration_in_seconds,
       description=EXCLUDED.description,workout_status=EXCLUDED.workout_status
     WHERE workouts.created_by=$6 OR workouts.created_by IS NULL`,
    [sourceID, String(workout.name ?? 'Workout'), workoutDurationSeconds(workout), workout.description ?? null, String(workout.status ?? 'active'), userID],
  );
  return { sourceID, sessionID };
}

function resumedArray(workout) {
  const values = [];
  if (Array.isArray(workout.pausePeriods)) {
    for (const p of workout.pausePeriods) if (p?.endedAt) values.push(p.endedAt);
  }
  if (workout.resumedAt && !values.includes(workout.resumedAt)) values.push(workout.resumedAt);
  return values;
}

export async function persistWorkoutSnapshot(client, { userID, workout }) {
  assertObject(workout, 'payload.workout');
  const { sourceID, sessionID } = await ensureWorkoutDefinition(client, { workout, userID });
  const result = await client.query(
    `INSERT INTO workout_sessions
      (title,status,started_at,resumed_at,ended_at,workout_id,created_by,session_data,client_workout_id)
     VALUES ($1,$2,$3,$4::timestamptz[],$5::timestamptz[],$6,$7,$8::jsonb,$9)
     ON CONFLICT (created_by,client_workout_id) DO UPDATE SET
       title=EXCLUDED.title,status=EXCLUDED.status,started_at=EXCLUDED.started_at,
       resumed_at=EXCLUDED.resumed_at,ended_at=EXCLUDED.ended_at,
       session_data=EXCLUDED.session_data,updated_at=NOW()
     RETURNING workout_session_id`,
    [
      String(workout.name ?? 'Workout'),
      String(workout.status ?? 'not_started'),
      workout.startedAt ?? null,
      resumedArray(workout),
      workout.endedAt ? [workout.endedAt] : [],
      sourceID,
      userID,
      JSON.stringify(workout),
      sessionID,
    ],
  );
  return { workout, workoutSessionID: result.rows[0].workout_session_id };
}

export async function latestPlayState(client, { userID, maxHistory, workoutID: requestedWorkoutID = null, sourceWorkoutID = null }) {
  const params = [userID];
  const filters = ["created_by=$1", "session_data <> '{}'::jsonb"];

  if (requestedWorkoutID) {
    params.push(requestedWorkoutID);
    filters.push(`client_workout_id=$${params.length}`);
  }

  if (sourceWorkoutID) {
    params.push(sourceWorkoutID);
    filters.push(`session_data->>'sourceWorkoutID'=$${params.length}`);
  }

  const session = await client.query(
    `SELECT workout_session_id,session_data FROM workout_sessions
     WHERE ${filters.join(' AND ')}
     ORDER BY updated_at DESC,created_at DESC LIMIT 1`,
    params,
  );
  if (!session.rowCount) return { workout: null, messages: [] };
  const id = session.rows[0].workout_session_id;
  const messages = await client.query(
    `SELECT m.workout_session_live_message_id AS id,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ',u.first_name,u.last_name)),''),u.username,'User') AS username,
            m.message,m.created_at
       FROM workout_session_live_messages m
       LEFT JOIN users u ON u.user_id=m.created_by
       WHERE m.workout_session_id=$1 ORDER BY m.created_at DESC LIMIT $2`,
    [id, maxHistory],
  );
  return {
    workout: session.rows[0].session_data,
    messages: messages.rows.reverse().map((m) => ({
      id: m.id,
      username: m.username,
      message: m.message,
      profileImageURL: null,
      createdAt: m.created_at,
    })),
  };
}

async function sessionForWorkout(client, { userID, workoutID: clientWorkoutID }) {
  const id = assertUUID(clientWorkoutID, 'workoutID');
  const result = await client.query(
    `SELECT workout_session_id FROM workout_sessions
     WHERE created_by=$1 AND client_workout_id=$2 ORDER BY updated_at DESC LIMIT 1`,
    [userID, id],
  );
  if (!result.rowCount) throw new GameError('not_found', 'Workout session does not exist.');
  return result.rows[0].workout_session_id;
}

export async function createLiveMessage(client, { userID, payload }) {
  const workoutIDValue = assertUUID(payload.workoutID, 'payload.workoutID');
  const sessionID = await sessionForWorkout(client, { userID, workoutID: workoutIDValue });
  const message = assertString(payload.message, 'payload.message').trim().slice(0, 4000);
  const exerciseID = optionalUUID(payload.workoutExerciseID);
  const id = randomUUID();
  const result = await client.query(
    `INSERT INTO workout_session_live_messages
      (workout_session_live_message_id,workout_session_id,workout_exercise_id,message,created_by,created_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW())) RETURNING created_at`,
    [id, sessionID, exerciseID, message, userID, payload.createdAt ?? null],
  );
  const user = await client.query(
    `SELECT COALESCE(NULLIF(TRIM(CONCAT_WS(' ',first_name,last_name)),''),username,'User') AS username FROM users WHERE user_id=$1`,
    [userID],
  );
  return { id, username: user.rows[0]?.username ?? 'User', message, profileImageURL: null, createdAt: result.rows[0].created_at };
}

export async function createLiveReaction(client, { userID, payload }) {
  const workoutIDValue = assertUUID(payload.workoutID, 'payload.workoutID');
  const sessionID = await sessionForWorkout(client, { userID, workoutID: workoutIDValue });
  const emoji = assertString(payload.emoji, 'payload.emoji').trim().slice(0, 64);
  const exerciseID = optionalUUID(payload.workoutExerciseID);
  const id = randomUUID();
  const result = await client.query(
    `INSERT INTO workout_session_live_reactions
      (workout_session_live_reaction_id,workout_session_id,workout_exercise_id,emoji,created_by,created_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW())) RETURNING created_at`,
    [id, sessionID, exerciseID, emoji, userID, payload.createdAt ?? null],
  );
  return { id, emoji, createdAt: result.rows[0].created_at };
}
