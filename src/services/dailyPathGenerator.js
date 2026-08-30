import crypto from 'node:crypto';
import { GameError } from '../lib/errors.js';
import { assertMapDate, assertTimeZone, assertUUID } from '../lib/validation.js';
import { stableUUID } from '../lib/stableUUID.js';
import { ensureDayMap, bumpRevision } from './dayMaps.js';
import { persistNode } from './nodes.js';
import { generateBackendRouteState } from './routes.js';
import { gridRouteAnchorForNode, makeGridRoadGraph } from './gridRoadGraph.js';
import { standardWeightLossDayRules } from '../rules/standardWeightLossDay.js';

function hashRules(rules) {
  return crypto.createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

function parseClock(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new GameError('validation_failed', `Invalid generated-day clock time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new GameError('validation_failed', `Invalid generated-day clock time: ${value}`);
  }
  return (hour * 3600) + (minute * 60);
}

function displayClock(secondsValue) {
  const seconds = Math.max(0, Math.min(86_399, Math.trunc(Number(secondsValue) || 0)));
  const hour24 = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  const period = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = (hour24 % 12) || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function coordinatePlacement(secondsFromMidnight, progressPercent) {
  return {
    coordinate: {
      _0: {
        time: { secondsFromMidnight },
        progress: { percent: progressPercent },
      },
    },
  };
}

function stopImageURL(stop) {
  const value = typeof stop?.imageURL === 'string' ? stop.imageURL.trim() : '';
  return value || null;
}

function remoteImage(urlString) {
  return urlString ? { remote: { urlString } } : null;
}

function baseActivity({ activityID, stop, mapDate, startSeconds, endSeconds }) {
  const imageURL = stopImageURL(stop);
  return {
    activityID,
    title: stop.title,
    date: mapDate,
    startTime: displayClock(startSeconds),
    endTime: displayClock(endSeconds),
    location: stop.location ?? '',
    description: stop.description ?? null,
    activityType: stop.kind,
    status: 'Not Started',
    ...(imageURL ? { image: remoteImage(imageURL) } : {}),
  };
}

function buildTaskContent({ userID, mapDate, rules, stop, startSeconds, endSeconds }) {
  const activityID = stableUUID(`${rules.name}:v${rules.version}:${userID}:${mapDate}:${stop.key}:activity`);
  const taskID = stableUUID(`${rules.name}:v${rules.version}:${userID}:${mapDate}:${stop.key}:task`);
  return {
    activity: {
      _0: {
        ...baseActivity({ activityID, stop, mapDate, startSeconds, endSeconds }),
        task: {
          activityTaskID: stableUUID(`${rules.name}:v${rules.version}:${userID}:${mapDate}:${stop.key}:activity-task`),
          taskID,
          title: stop.title,
          description: stop.description ?? '',
          imageURLs: stopImageURL(stop) ? [stopImageURL(stop)] : null,
          videoURLs: null,
        },
      },
    },
  };
}

function buildMealContent({ userID, mapDate, rules, stop, startSeconds, endSeconds }) {
  const activityID = stableUUID(`${rules.name}:v${rules.version}:${userID}:${mapDate}:${stop.key}:activity`);
  const suggestedMealID = stableUUID(`${rules.name}:v${rules.version}:${userID}:${mapDate}:${stop.key}:suggested-meal`);
  const mealID = stableUUID(`${rules.name}:v${rules.version}:${stop.key}:meal-template`);
  return {
    activity: {
      _0: {
        ...baseActivity({ activityID, stop, mapDate, startSeconds, endSeconds }),
        meal: {
          suggestedMealID,
          title: stop.title,
          estimatedTimeMinutes: Math.max(0, Math.trunc(stop.durationMinutes ?? 0)),
          priceRange: '$',
          imageURL: stopImageURL(stop),
          meals: [
            {
              mealID,
              title: stop.title,
              imageURL: stopImageURL(stop),
              estimatedTimeMinutes: Math.max(0, Math.trunc(stop.durationMinutes ?? 0)),
              priceRange: '$',
              recipeCount: 1,
              ingredientCount: 0,
              sourceCount: 0,
            },
          ],
        },
      },
    },
  };
}

function buildWorkoutContent({ userID, mapDate, rules, stop, startSeconds, endSeconds }) {
  const activityID = stableUUID(`${rules.name}:v${rules.version}:${userID}:${mapDate}:${stop.key}:activity`);
  const workoutTemplateName = stop.workoutTemplateRulesName ?? rules.name;
  const workoutTemplateVersion = stop.workoutTemplateRulesVersion ?? rules.version;
  const workoutTemplateKey = stop.workoutTemplateKey ?? stop.key;
  const workoutID = stableUUID(`${workoutTemplateName}:v${workoutTemplateVersion}:${workoutTemplateKey}:workout-template`);
  const durationSeconds = Math.max(0, Math.trunc((stop.durationMinutes ?? 0) * 60));
  return {
    activity: {
      _0: {
        ...baseActivity({ activityID, stop, mapDate, startSeconds, endSeconds }),
        workout: {
          activityWorkoutID: stableUUID(`${rules.name}:v${rules.version}:${userID}:${mapDate}:${stop.key}:activity-workout`),
          workoutID,
          title: stop.title,
          location: stop.location ?? '',
          categories: Array.isArray(stop.categories) ? stop.categories : [],
          selectedWorkoutTime: displayClock(startSeconds),
          durationInSeconds: durationSeconds,
          durationText: `${Math.max(0, Math.trunc(stop.durationMinutes ?? 0))} min`,
          distance: '',
          workoutFormat: stop.workoutFormat ?? 'Independent',
          rating: '',
          workoutType: 'independent',
          imageURLs: stopImageURL(stop) ? [stopImageURL(stop)] : null,
          description: stop.description ?? null,
          workoutStatus: 'Not Started',
        },
      },
    },
  };
}

export function buildGeneratedDayNode({ userID, mapDate, rules, stop }) {
  const startSeconds = parseClock(stop.start);
  const endSeconds = Math.min(86_399, startSeconds + Math.max(0, Math.trunc((stop.durationMinutes ?? 0) * 60)));
  const progressPercent = Number.isFinite(Number(stop.progressPercent)) ? Number(stop.progressPercent) : 0;
  const nodeID = stableUUID(`${rules.name}:v${rules.version}:${userID}:${mapDate}:${stop.key}:node`);

  let content;
  if (stop.kind === 'meal') {
    content = buildMealContent({ userID, mapDate, rules, stop, startSeconds, endSeconds });
  } else if (stop.kind === 'workout') {
    content = buildWorkoutContent({ userID, mapDate, rules, stop, startSeconds, endSeconds });
  } else if (stop.kind === 'task') {
    content = buildTaskContent({ userID, mapDate, rules, stop, startSeconds, endSeconds });
  } else {
    throw new GameError('validation_failed', `Unsupported generated-day stop kind: ${stop.kind}`);
  }

  const node = {
    id: { rawValue: nodeID },
    placement: coordinatePlacement(startSeconds, progressPercent),
    time: { secondsFromMidnight: startSeconds },
    content,
    isEnabled: true,
  };

  return {
    key: stop.key,
    nodeID,
    node,
    anchor: gridRouteAnchorForNode({ nodeID, secondsFromMidnight: startSeconds, progressPercent }),
  };
}

export function buildStandardWeightLossDay({ userID, mapDate, rules = standardWeightLossDayRules() }) {
  assertUUID(userID, 'userID');
  const validatedMapDate = assertMapDate(mapDate, 'mapDate');
  if (!rules || typeof rules !== 'object' || !String(rules.name ?? '').trim()) {
    throw new GameError('validation_failed', 'Daily generation rules require a name.');
  }
  if (!Number.isInteger(Number(rules.version)) || Number(rules.version) <= 0) {
    throw new GameError('validation_failed', 'Daily generation rules require a positive integer version.');
  }
  if (!Array.isArray(rules.stops) || !rules.stops.length) {
    throw new GameError('validation_failed', 'Daily generation rules must contain at least one stop.');
  }
  const keys = rules.stops.map((stop) => String(stop?.key ?? '').trim());
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) {
    throw new GameError('validation_failed', 'Every generated-day stop requires a unique non-empty key.');
  }

  const generated = rules.stops.map((stop) => buildGeneratedDayNode({ userID, mapDate: validatedMapDate, rules, stop }));
  generated.sort((a, b) => a.node.time.secondsFromMidnight - b.node.time.secondsFromMidnight);
  return {
    rules,
    rulesHash: hashRules(rules),
    nodes: generated,
  };
}

async function generationRun(client, dayMapID) {
  const result = await client.query(
    `SELECT generator_name,generator_version,rules_hash,generated_node_ids
       FROM day_map_generation_runs WHERE day_map_id=$1`,
    [dayMapID],
  );
  return result.rows[0] ?? null;
}

async function generatedNodesStillExist(client, dayMapID, nodeIDs) {
  if (!nodeIDs?.length) return false;
  const result = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM day_map_nodes
      WHERE day_map_id=$1 AND node_id=ANY($2::uuid[]) AND is_enabled=TRUE`,
    [dayMapID, nodeIDs],
  );
  return Number(result.rows[0]?.count ?? 0) === nodeIDs.length;
}

/**
 * Generates and persists one authoritative user/day path.
 *
 * - Idempotent by rules hash.
 * - Replaces only nodes previously created by this generator.
 * - Never deletes manually created user nodes.
 * - Uses the same backend route builder that powers normal client mutations.
 */
export async function generateDailyPathForUser(client, {
  userID,
  mapDate,
  timeZoneIdentifier = 'America/New_York',
  rules = standardWeightLossDayRules(),
  force = false,
  currentDayTimeSeconds = 0,
  maxAlternatives = 3,
} = {}) {
  const id = assertUUID(userID, 'userID');
  const validatedMapDate = assertMapDate(mapDate, 'mapDate');
  const validatedTimeZone = assertTimeZone(timeZoneIdentifier, 'timeZoneIdentifier');
  const user = await client.query('SELECT user_id FROM users WHERE user_id=$1', [id]);
  if (!user.rowCount) throw new GameError('not_found', 'Cannot generate a daily path for an unknown user.');

  const dayMap = await ensureDayMap(client, {
    userID: id,
    mapDate: validatedMapDate,
    timeZoneIdentifier: validatedTimeZone,
  });

  const plan = buildStandardWeightLossDay({ userID: id, mapDate: validatedMapDate, rules });
  const newNodeIDs = plan.nodes.map((entry) => entry.nodeID);
  const prior = await generationRun(client, dayMap.day_map_id);

  if (!force
      && prior
      && prior.generator_name === rules.name
      && Number(prior.generator_version) === Number(rules.version)
      && prior.rules_hash === plan.rulesHash
      && await generatedNodesStillExist(client, dayMap.day_map_id, newNodeIDs)) {
    return {
      generated: false,
      reason: 'already_generated',
      dayMapID: dayMap.day_map_id,
      mapDate: validatedMapDate,
      userID: id,
      revision: Number(dayMap.revision),
      generatedNodeIDs: newNodeIDs,
      rules: { name: rules.name, version: rules.version, hash: plan.rulesHash },
    };
  }

  const priorNodeIDs = Array.isArray(prior?.generated_node_ids) ? prior.generated_node_ids : [];
  if (priorNodeIDs.length) {
    await client.query(
      `DELETE FROM day_map_nodes
        WHERE day_map_id=$1 AND node_id=ANY($2::uuid[])`,
      [dayMap.day_map_id, priorNodeIDs],
    );
  }

  const context = { mapDate: validatedMapDate, timeZoneIdentifier: validatedTimeZone };
  const persistedNodes = [];
  for (const entry of plan.nodes) {
    const persisted = await persistNode(client, {
      dayMap,
      userID: id,
      context,
      node: entry.node,
    });
    persistedNodes.push(persisted.node);
  }

  const roadGraph = makeGridRoadGraph();
  const routeResult = await generateBackendRouteState(client, {
    dayMap,
    payload: {
      roadGraph,
      nodeAnchors: plan.nodes.map((entry) => entry.anchor),
      currentDayTime: {
        secondsFromMidnight: Math.max(0, Math.min(86_400, Number(currentDayTimeSeconds) || 0)),
      },
      maxAlternatives,
    },
  });

  await client.query(
    `INSERT INTO day_map_generation_runs(
       day_map_id,user_id,generator_name,generator_version,rules_hash,generated_node_ids,generated_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6::uuid[],NOW(),NOW())
     ON CONFLICT(day_map_id) DO UPDATE SET
       user_id=EXCLUDED.user_id,
       generator_name=EXCLUDED.generator_name,
       generator_version=EXCLUDED.generator_version,
       rules_hash=EXCLUDED.rules_hash,
       generated_node_ids=EXCLUDED.generated_node_ids,
       generated_at=NOW(),
       updated_at=NOW()`,
    [dayMap.day_map_id, id, rules.name, rules.version, plan.rulesHash, newNodeIDs],
  );

  const revision = await bumpRevision(client, dayMap.day_map_id);
  return {
    generated: true,
    dayMapID: dayMap.day_map_id,
    mapDate: validatedMapDate,
    userID: id,
    revision,
    generatedNodeIDs: newNodeIDs,
    nodes: persistedNodes,
    routeState: routeResult.routeState,
    rules: { name: rules.name, version: rules.version, hash: plan.rulesHash },
  };
}
