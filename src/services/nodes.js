import { GameError } from '../lib/errors.js';
import { assertObject, assertUUID, optionalUUID } from '../lib/validation.js';
import {
  activityContent,
  activityEndTimeSeconds,
  cloneNode,
  activityMainImageURL,
  gameNodeID,
  imageURL,
  nodeKind,
  nodeProgressPercent,
  nodeSourceUUID,
  nodeTimeSeconds,
  normalizedStatus,
  numberFromText,
  postContent,
  reconcileNodeMediaMetadata,
} from '../lib/nodeCodec.js';

function postgresTimestampExpression(paramOffset, dayOffset = 0) {
  const normalizedDayOffset = Number.isFinite(Number(dayOffset))
    ? Math.trunc(Number(dayOffset))
    : 0;
  return `($${paramOffset}::date + ${normalizedDayOffset} + make_interval(secs => $${paramOffset + 1}::int)) AT TIME ZONE $${paramOffset + 2}`;
}

export function activityEndDayOffset(startSeconds, endSeconds) {
  if (!Number.isFinite(Number(startSeconds)) || !Number.isFinite(Number(endSeconds))) {
    return 0;
  }
  return Number(endSeconds) < Number(startSeconds) ? 1 : 0;
}

function canonicalizeActivityTaskNode(node) {
  const copy = cloneNode(node);
  const activity = activityContent(copy);
  if (!activity?.task) return copy;

  const activityType = String(activity.activityType ?? '').trim().toLowerCase();
  if (activityType !== 'task') return copy;

  // Older/generic editors can change Activity.title without changing the
  // duplicated ActivityTaskNodeSummary.title. The iOS Task experience prefers
  // the nested task title, so persisting mismatched values makes a successful
  // edit appear to revert after the next authoritative snapshot.
  const activityTitle = String(activity.title ?? '').trim();
  const taskTitle = String(activity.task.title ?? '').trim();
  const canonicalTitle = activityTitle || taskTitle || 'Task';

  activity.title = canonicalTitle;
  activity.task.title = canonicalTitle;
  return copy;
}

async function upsertActivity(client, { node, userID, context }) {
  const activity = activityContent(node);
  if (!activity) return null;
  const activityID = optionalUUID(activity.activityID);
  if (!activityID) return null;

  const startSeconds = nodeTimeSeconds(node);
  const endSeconds = activityEndTimeSeconds(activity);
  const startExpr = postgresTimestampExpression(7);
  const endDayOffset =
    endSeconds == null
      ? 0
      : activityEndDayOffset(startSeconds, endSeconds);
  const endExpr =
    endSeconds == null
      ? 'NULL'
      : postgresTimestampExpression(10, endDayOffset);

  const params = [
    activityID,
    String(activity.title ?? 'Activity'),
    String(activity.location ?? ''),
    activityMainImageURL(activity),
    normalizedStatus(activity.status),
    userID,
    context.mapDate,
    startSeconds,
    context.timeZoneIdentifier,
  ];
  if (endSeconds != null) params.push(context.mapDate, endSeconds, context.timeZoneIdentifier);
  params.push(activity.description ?? null);
  const descriptionIndex = params.length;

  const activityWrite = await client.query(
    `INSERT INTO activities
      (activity_id,title,start_time,end_time,location,main_image_url,status,created_by,description)
     VALUES ($1,$2,${startExpr},${endExpr},NULLIF($3,''),$4,$5,$6,$${descriptionIndex})
     ON CONFLICT (activity_id) DO UPDATE SET
       title=EXCLUDED.title,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,
       location=EXCLUDED.location,main_image_url=EXCLUDED.main_image_url,
       status=EXCLUDED.status,description=EXCLUDED.description,
       updated_at=NOW()
     WHERE activities.created_by=$6 OR activities.created_by IS NULL
     RETURNING activity_id`,
    params,
  );

  // A Day Map may reference a shared/class activity owned by another account.
  // Keep that canonical record immutable, but allow the user's own node snapshot
  // and check-in relation to reference it.
  if (!activityWrite.rowCount) return activityID;

  if (activity.task) await upsertTask(client, { activityID, activity, userID });
  if (activity.workout) await upsertActivityWorkout(client, { activityID, activity, userID });
  if (activity.meal) await upsertSuggestedMeal(client, { activityID, activity, userID });
  return activityID;
}

async function upsertTask(client, { activityID, activity, userID }) {
  const task = activity.task;
  const taskID = optionalUUID(task?.taskID);
  if (!taskID) return;
  const images = Array.isArray(task.imageURLs) ? task.imageURLs.filter(Boolean) : [];
  await client.query(
    `INSERT INTO tasks (task_id,title,task_main_image_url,location,status,created_by,description)
     VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7)
     ON CONFLICT (task_id) DO UPDATE SET
       title=EXCLUDED.title,task_main_image_url=EXCLUDED.task_main_image_url,
       location=EXCLUDED.location,status=EXCLUDED.status,description=EXCLUDED.description,
       updated_at=NOW()
     WHERE tasks.created_by=$6 OR tasks.created_by IS NULL`,
    [taskID, task.title ?? activity.title ?? 'Task', images[0] ?? null, activity.location ?? '', normalizedStatus(activity.status), userID, task.description ?? activity.description ?? null],
  );
  await client.query(
    `INSERT INTO activities_tasks(activity_id,task_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [activityID, taskID],
  );
}

async function upsertActivityWorkout(client, { activityID, activity, userID }) {
  const workout = activity.workout;
  const workoutID = optionalUUID(workout?.workoutID);
  if (!workoutID) return;
  const images = Array.isArray(workout.imageURLs) ? workout.imageURLs.filter(Boolean) : [];
  const categories = Array.isArray(workout.categories) ? workout.categories.map(String) : [];
  const distance = numberFromText(workout.distance);
  await client.query(
    `INSERT INTO workouts
      (workout_id,title,workout_main_image_url,location,duration_in_seconds,workout_categories,description,distance_in_miles,workout_status,workout_format,created_by,workout_image_urls,tags)
     VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$6)
     ON CONFLICT (workout_id) DO UPDATE SET
       title=EXCLUDED.title,workout_main_image_url=EXCLUDED.workout_main_image_url,
       location=EXCLUDED.location,duration_in_seconds=EXCLUDED.duration_in_seconds,
       workout_categories=EXCLUDED.workout_categories,description=EXCLUDED.description,
       distance_in_miles=EXCLUDED.distance_in_miles,workout_status=EXCLUDED.workout_status,
       workout_format=EXCLUDED.workout_format,workout_image_urls=EXCLUDED.workout_image_urls,
       tags=EXCLUDED.tags
     WHERE workouts.created_by=$11 OR workouts.created_by IS NULL`,
    [
      workoutID,
      workout.title ?? activity.title ?? 'Workout',
      images[0] ?? null,
      workout.location ?? activity.location ?? '',
      Number.isFinite(Number(workout.durationInSeconds)) ? Math.max(0, Math.trunc(Number(workout.durationInSeconds))) : null,
      categories,
      workout.description ?? activity.description ?? null,
      distance,
      normalizedStatus(workout.workoutStatus ?? activity.status),
      workout.workoutFormat ?? workout.workoutType ?? null,
      userID,
      images,
    ],
  );
  await client.query(
    `DELETE FROM activities_workouts WHERE activity_id=$1 AND workout_id<>$2`,
    [activityID, workoutID],
  );
  await client.query(
    `INSERT INTO activities_workouts(activity_id,workout_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [activityID, workoutID],
  );
}

async function upsertSuggestedMeal(client, { activityID, activity, userID }) {
  const meal = activity.meal;
  const suggestionID = optionalUUID(meal?.suggestedMealID);
  if (!suggestionID) return;
  const meals = Array.isArray(meal.meals) ? meal.meals : [];
  const executionState = meal.executionPlan ?? {};
  await client.query(
    `INSERT INTO suggested_meals
      (suggested_meal_id,user_id,status,meals,execution_state)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
     ON CONFLICT (suggested_meal_id) DO UPDATE SET
       status=EXCLUDED.status,meals=EXCLUDED.meals,execution_state=EXCLUDED.execution_state,
       updated_at=NOW()
     WHERE suggested_meals.user_id=$2`,
    [suggestionID, userID, normalizedStatus(activity.status, 'pending'), JSON.stringify(meals), JSON.stringify(executionState)],
  );
  await client.query(
    `INSERT INTO activities_suggested_meals(activity_id,suggested_meal_id) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [activityID, suggestionID],
  );
}

async function upsertPost(client, { node, userID }) {
  const post = postContent(node);
  if (!post) return null;
  const postID = optionalUUID(post.postID);
  if (!postID) return null;
  const s = post.snapshot ?? {};
  const images = Array.isArray(s.postImageURLs) ? s.postImageURLs.filter(Boolean) : [];
  const videos = Array.isArray(s.postVideoURLs) ? s.postVideoURLs.filter(Boolean) : [];
  const tags = Array.isArray(s.tags) ? s.tags.map(String) : [];
  const posterID = optionalUUID(s.posterID) ?? userID;
  await client.query(
    `INSERT INTO posts
      (post_id,post_type,subject,post_main_media_url,post_main_media_type,post_media_count,post_image_urls,post_video_urls,post_gif_media,poster_id,created_at,post_status,tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,COALESCE($11::timestamptz,NOW()),$12,$13)
     ON CONFLICT (post_id) DO UPDATE SET
       post_type=EXCLUDED.post_type,
       subject=EXCLUDED.subject,
       post_main_media_url=EXCLUDED.post_main_media_url,
       post_main_media_type=EXCLUDED.post_main_media_type,
       post_media_count=EXCLUDED.post_media_count,
       post_image_urls=EXCLUDED.post_image_urls,
       post_video_urls=EXCLUDED.post_video_urls,
       post_gif_media=EXCLUDED.post_gif_media,
       post_status=EXCLUDED.post_status,
       tags=EXCLUDED.tags
     WHERE posts.poster_id=$10 OR posts.poster_id IS NULL`,
    [
      postID,
      s.postType ?? 'Post',
      s.subject ?? post.title ?? 'Post',
      s.postMainMediaURL || null,
      s.postMainMediaType || null,
      Math.max(0, Number(s.postMediaCount ?? (images.length + videos.length)) || 0),
      images,
      videos,
      JSON.stringify(s.postGIFMedia ?? {}),
      posterID,
      s.createdAt || null,
      normalizedStatus(s.status),
      tags,
    ],
  );
  return postID;
}

export async function persistNode(client, { dayMap, userID, context, node }) {
  assertObject(node, 'payload.node');
  const canonicalNode = reconcileNodeMediaMetadata(
    canonicalizeActivityTaskNode(node),
  );
  const id = assertUUID(gameNodeID(canonicalNode), 'node.id');
  const existing = await client.query(
    `SELECT progress FROM day_map_nodes WHERE node_id=$1 AND day_map_id=$2`,
    [id, dayMap.day_map_id],
  );

  const kind = nodeKind(canonicalNode);
  let sourceID = nodeSourceUUID(canonicalNode);
  if (kind.startsWith('activity')) sourceID = (await upsertActivity(client, { node: canonicalNode, userID, context })) ?? sourceID;
  if (kind === 'post') sourceID = (await upsertPost(client, { node: canonicalNode, userID })) ?? sourceID;

  const timeSeconds = nodeTimeSeconds(canonicalNode);
  const progress = nodeProgressPercent(canonicalNode, existing.rows[0]?.progress ?? 0);
  const enabled = canonicalNode.isEnabled !== false;

  const nodeWrite = await client.query(
    `INSERT INTO day_map_nodes
      (node_id,day_map_id,node_kind,source_id,node_data,time_seconds,progress,is_enabled)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
     ON CONFLICT (node_id) DO UPDATE SET
       node_kind=EXCLUDED.node_kind,source_id=EXCLUDED.source_id,
       node_data=EXCLUDED.node_data,time_seconds=EXCLUDED.time_seconds,
       progress=EXCLUDED.progress,is_enabled=EXCLUDED.is_enabled,updated_at=NOW()
     WHERE day_map_nodes.day_map_id=EXCLUDED.day_map_id
     RETURNING node_id`,
    [id, dayMap.day_map_id, kind, sourceID, JSON.stringify(canonicalNode), timeSeconds, progress, enabled],
  );
  if (!nodeWrite.rowCount) {
    throw new GameError('forbidden', 'node.id already belongs to a different Day Map.');
  }
  return { node: canonicalNode, nodeID: id, kind, sourceID };
}

export async function loadOwnedNode(client, { dayMapID, nodeID }) {
  const id = assertUUID(nodeID, 'nodeID');
  const result = await client.query(
    `SELECT node_data,node_kind,source_id FROM day_map_nodes WHERE day_map_id=$1 AND node_id=$2`,
    [dayMapID, id],
  );
  if (!result.rowCount) throw new GameError('not_found', 'Day Map node was not found.');
  return { node: result.rows[0].node_data, kind: result.rows[0].node_kind, sourceID: result.rows[0].source_id };
}

export async function deleteNode(client, { dayMap, nodeID }) {
  const id = assertUUID(nodeID, 'payload.nodeID');
  const result = await client.query(
    `DELETE FROM day_map_nodes WHERE day_map_id=$1 AND node_id=$2 RETURNING node_id`,
    [dayMap.day_map_id, id],
  );
  if (!result.rowCount) throw new GameError('not_found', 'Day Map node was not found.');
  return { nodeID: id };
}

export async function persistActivityNode(client, args) {
  return persistNode(client, args);
}

export async function markActivityCheckIn(client, { node, userID }) {
  const activity = activityContent(node);
  const activityID = optionalUUID(activity?.activityID);
  if (!activityID) return;
  await client.query(
    `INSERT INTO activities_users(activity_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [activityID, userID],
  );
  await client.query(
    `INSERT INTO activity_check_ins(activity_id,user_id,status,checked_in_at)
     VALUES ($1,$2,'checked_in',NOW())
     ON CONFLICT(activity_id,user_id) DO UPDATE SET
       status='checked_in',checked_in_at=NOW(),updated_at=NOW()`,
    [activityID, userID],
  );
}

export async function persistPostSave(client, { dayMap, userID, context, node }) {
  const persisted = await persistNode(client, { dayMap, userID, context, node });
  const post = postContent(node);
  const postID = optionalUUID(post?.postID);
  if (!postID) throw new GameError('validation_failed', 'Post node does not contain a UUID postID.');
  await client.query(
    `INSERT INTO post_saves(user_id,post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userID, postID],
  );
  return persisted;
}

export async function persistHyperlinkVote(client, { dayMap, userID, nodeID, vote }) {
  const id = assertUUID(nodeID, 'payload.nodeID');
  if (!['upvote', 'downvote'].includes(vote)) throw new GameError('invalid_payload', 'vote must be upvote or downvote.');
  const node = await loadOwnedNode(client, { dayMapID: dayMap.day_map_id, nodeID: id });
  if (node.kind !== 'hyperlink') throw new GameError('validation_failed', 'Vote target is not a hyperlink node.');
  await client.query(
    `INSERT INTO day_map_hyperlink_votes(day_map_id,node_id,user_id,vote)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT(day_map_id,node_id,user_id) DO UPDATE SET vote=EXCLUDED.vote,updated_at=NOW()`,
    [dayMap.day_map_id, id, userID, vote],
  );
  return { nodeID: id };
}
