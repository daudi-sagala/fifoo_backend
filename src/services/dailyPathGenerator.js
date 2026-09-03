import crypto from 'node:crypto';
import { GameError } from '../lib/errors.js';
import { assertMapDate, assertTimeZone, assertUUID } from '../lib/validation.js';
import { stableUUID } from '../lib/stableUUID.js';
import { ensureDayMap, bumpRevision } from './dayMaps.js';
import { persistNode } from './nodes.js';
import { generateBackendRouteState } from './routes.js';
import { gridRouteAnchorForNode, makeGridRoadGraph } from './gridRoadGraph.js';
import { standardWeightLossDayRules } from '../rules/standardWeightLossDay.js';
import { compileContinuousDay, projectSystemStateProgress } from '../algorithms/dayGraph.js';
import { allocateDailyBudget } from '../algorithms/progressEngine.js';
import { activeDayPlanExists, persistCompiledDayPlan } from './dayPlanning.js';
import { captureRoutingDecision, routeObservation } from './learningData.js';
import { linkPredictionScoreRun, scoreCandidatesForRouting } from './predictionService.js';

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
          ...(stop.executionPlan ? { executionPlan: stop.executionPlan } : {}),
          ...(stop.routeKnowledge ? { routeKnowledge: stop.routeKnowledge } : {}),
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
  const entriesByKey = new Map(generated.map((entry) => [entry.key, entry]));
  const scheduledIntervals = rules.stops.map((stop) => {
    const entry = entriesByKey.get(stop.key);
    const startSecond = entry.node.time.secondsFromMidnight;
    const endSecond = Math.min(
      86_400,
      startSecond + Math.max(1, Math.trunc(Number(stop.durationMinutes ?? 0) * 60)),
    );
    return {
      key: stop.key,
      candidateKey: stop.key,
      sourceNodeID: entry.nodeID,
      intervalKind: stop.kind,
      startSecond,
      endSecond,
      progressCategory: stop.progressCategory,
      progressWeightHint: stop.progressWeightHint,
      completionEvaluator: stop.completionEvaluator ?? (
        stop.kind === 'workout'
          ? { type: 'duration', plannedSeconds: endSecond - startSecond }
          : { type: 'binary' }
      ),
      metabolicContext: stop.kind === 'meal' ? 'fed' : null,
      metadata: {
        title: stop.title,
        location: stop.location ?? '',
        generatorStop: true,
      },
    };
  });
  const continuousPath = compileContinuousDay({
    scheduledIntervals,
    idSeed: `${rules.name}:v${rules.version}:${userID}:${validatedMapDate}`,
    pathKey: 'chosen',
    pathKind: 'chosen',
    context: rules.dayContext ?? {},
  });
  continuousPath.intervals = allocateDailyBudget(continuousPath.intervals, {
    categoryBudgets: rules.categoryBudgets,
  });
  continuousPath.systemStateIntervals = projectSystemStateProgress(
    continuousPath.systemStateIntervals ?? [],
    continuousPath.intervals,
  );
  continuousPath.routeScore = null;
  continuousPath.expectedProgress = continuousPath.intervals.reduce((total, interval) => (
    total + Number(interval.potentialPoints ?? 0) * Number(
      interval.metadata?.completionProbability
        ?? (interval.intervalKind === 'freeTime' ? 0 : 0.65),
    )
  ), 0);
  return {
    rules,
    rulesHash: hashRules(rules),
    nodes: generated,
    dayGraph: {
      schema: 'fifoo.day-graph.v3',
      chosenPath: continuousPath,
      alternativeBranches: [],
    },
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



function ruleClock(secondsValue) {
  const seconds = Math.max(0, Math.min(86_399, Math.trunc(Number(secondsValue) || 0)));
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function overlapsAny(startSecond, endSecond, intervals = []) {
  return intervals.some((interval) => (
    startSecond < Number(interval.endSecond) && Number(interval.startSecond) < endSecond
  ));
}

function knowledgeSelections(value) {
  return Array.isArray(value?.selections)
    ? value.selections.map((entry) => String(entry?.key ?? '')).filter(Boolean)
    : [];
}

async function userRouteKnowledgeProfile(client, userID) {
  const [knowledgeRows, workRows] = await Promise.all([
    client.query(
      'SELECT knowledge_key,knowledge_value FROM user_route_knowledge WHERE user_id=$1',
      [userID],
    ),
    client.query(
      `SELECT preference_data FROM user_schedule_preferences
        WHERE user_id=$1 AND schedule_key='work' LIMIT 1`,
      [userID],
    ),
  ]);
  return {
    knowledge: Object.fromEntries(
      knowledgeRows.rows.map((row) => [String(row.knowledge_key), row.knowledge_value ?? {}]),
    ),
    work: workRows.rows[0]?.preference_data ?? null,
  };
}

function workBusyWindows(work) {
  if (work?.type !== 'fixed') return [];
  const start = parseClock(work.startTime);
  const end = parseClock(work.endTime);
  if (start === end) return [];
  if (end > start) return [{ startSecond: start, endSecond: end }];
  return [
    { startSecond: 0, endSecond: end },
    { startSecond: start, endSecond: 86_400 },
  ];
}

function nearestAvailableStart(preferred, durationSeconds, occupied) {
  const step = 15 * 60;
  const maxDelta = 16 * 3600;
  for (let delta = 0; delta <= maxDelta; delta += step) {
    const options = delta === 0 ? [preferred] : [preferred + delta, preferred - delta];
    for (const candidate of options) {
      const start = Math.max(0, Math.min(86_400 - durationSeconds, Math.trunc(candidate)));
      const end = start + durationSeconds;
      if (!overlapsAny(start, end, occupied)) return start;
    }
  }
  return preferred;
}

function personalizeRulesFromRouteKnowledge(rules, profile, dayContext) {
  const knowledge = profile?.knowledge ?? {};
  const workBusy = workBusyWindows(profile?.work);
  const sleepBusy = Array.isArray(dayContext?.sleepWindows) ? dayContext.sleepWindows : [];
  const dietStyle = String(knowledge.diet_style?.key ?? knowledge.diet_style?.optionID ?? '');
  const allergies = knowledgeSelections(knowledge.food_allergies).filter((key) => key !== 'none');
  const gymAvailable = knowledge.gym_access?.available;
  const cookingFrequency = String(knowledge.cooking_frequency?.frequency ?? '');
  const groceryReadiness = String(knowledge.groceries_readiness?.key ?? '');

  let stops = rules.stops.map((stop) => {
    const next = { ...stop };
    if (next.kind === 'meal') {
      next.routeKnowledge = {
        dietStyle: dietStyle || null,
        allergyConstraints: allergies,
      };
      if (dietStyle && !['omnivore', 'other'].includes(dietStyle)) {
        const prefix = dietStyle === 'low_carb' ? 'Lower-carb' : `${dietStyle[0].toUpperCase()}${dietStyle.slice(1)}`;
        next.title = `${prefix} ${String(next.title).replace(/^Balanced\s+/i, '').replace(/^Protein-rich\s+/i, '')}`;
        next.description = `${next.description ?? ''} Rank choices that match the saved ${dietStyle.replace('_', ' ')} preference.`.trim();
      }
      if (allergies.length) {
        next.description = `${next.description ?? ''} Filter candidate meals against the user's saved allergen constraints; the user must still verify ingredients and preparation.`.trim();
      }
      if (next.key === 'dinner' && cookingFrequency === 'most_days') {
        next.executionPlan = {
          ...(next.executionPlan ?? {}),
          source: 'homeMade',
          groceriesNeeded: groceryReadiness === 'rarely',
        };
      }
    }

    if (next.kind === 'workout' && gymAvailable === false && next.key === 'strength-workout') {
      next.title = 'At-home full-body strength';
      next.location = 'Home';
      next.categories = [...new Set([...(next.categories ?? []), 'Bodyweight', 'Home Workout'])];
      next.description = 'A full-body strength session that does not require reliable gym access.';
    }
    return next;
  });

  const occupied = [
    ...workBusy,
    ...sleepBusy,
    ...stops.filter((stop) => stop.kind === 'meal').map((stop) => {
      const startSecond = parseClock(stop.start);
      return {
        startSecond,
        endSecond: Math.min(86_400, startSecond + Math.max(60, Number(stop.durationMinutes ?? 1) * 60)),
      };
    }),
  ];

  stops = stops
    .sort((a, b) => parseClock(a.start) - parseClock(b.start))
    .map((stop) => {
      if (stop.kind === 'meal') return stop;
      const durationSeconds = Math.max(60, Number(stop.durationMinutes ?? 1) * 60);
      const preferred = parseClock(stop.start);
      const preferredEnd = preferred + durationSeconds;
      let startSecond = preferred;
      if (overlapsAny(preferred, preferredEnd, occupied)) {
        startSecond = nearestAvailableStart(preferred, durationSeconds, occupied);
      }
      occupied.push({ startSecond, endSecond: startSecond + durationSeconds });
      return { ...stop, start: ruleClock(startSecond) };
    })
    .sort((a, b) => parseClock(a.start) - parseClock(b.start));

  return {
    ...rules,
    dayContext: {
      ...(rules.dayContext ?? {}),
      ...dayContext,
      hardBusyIntervals: [...sleepBusy, ...workBusy],
      routeKnowledge: {
        dietStyle: dietStyle || null,
        allergyCount: allergies.length,
        gymAvailable: typeof gymAvailable === 'boolean' ? gymAvailable : null,
        cookingFrequency: cookingFrequency || null,
      },
    },
    stops,
  };
}

async function userSleepDayContext(client, userID, fallback = {}) {
  const result = await client.query(
    `SELECT schedule_key,EXTRACT(EPOCH FROM clock_time)::int AS second_of_day
       FROM user_schedule_preferences
      WHERE user_id=$1 AND schedule_key IN ('wake','bed') AND clock_time IS NOT NULL`,
    [userID],
  );
  const byKey = new Map(result.rows.map((row) => [row.schedule_key, Number(row.second_of_day)]));
  const wakeSecond = Math.max(0, Math.min(86_400, Math.trunc(
    Number.isFinite(byKey.get('wake')) ? byKey.get('wake') : Number(fallback.wakeSecond ?? 7 * 3600),
  )));
  const sleepSecond = Math.max(0, Math.min(86_400, Math.trunc(
    Number.isFinite(byKey.get('bed')) ? byKey.get('bed') : Number(fallback.sleepSecond ?? 23 * 3600),
  )));
  const sleepWindows = sleepSecond >= wakeSecond
    ? [
        ...(wakeSecond > 0 ? [{ startSecond: 0, endSecond: wakeSecond }] : []),
        ...(sleepSecond < 86_400 ? [{ startSecond: sleepSecond, endSecond: 86_400 }] : []),
      ]
    : [{ startSecond: sleepSecond, endSecond: wakeSecond }];
  return {
    ...fallback,
    wakeSecond,
    sleepSecond,
    sleepWindows,
  };
}

export async function generateDailyPathForUser(client, {
  userID,
  mapDate,
  timeZoneIdentifier = 'America/New_York',
  rules = standardWeightLossDayRules(),
  force = false,
  currentDayTimeSeconds = 0,
  maxAlternatives = 3,
  predictionRuntimeMode = 'legacy',
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

  const personalizedDayContext = await userSleepDayContext(
    client,
    id,
    rules.dayContext ?? {},
  );
  const routeKnowledgeProfile = await userRouteKnowledgeProfile(client, id);
  const resolvedRules = personalizeRulesFromRouteKnowledge(
    { ...rules, dayContext: personalizedDayContext },
    routeKnowledgeProfile,
    personalizedDayContext,
  );

  const plan = buildStandardWeightLossDay({ userID: id, mapDate: validatedMapDate, rules: resolvedRules });
  const newNodeIDs = plan.nodes.map((entry) => entry.nodeID);
  const prior = await generationRun(client, dayMap.day_map_id);

  if (!force
      && prior
      && prior.generator_name === resolvedRules.name
      && Number(prior.generator_version) === Number(resolvedRules.version)
      && prior.rules_hash === plan.rulesHash
      && await generatedNodesStillExist(client, dayMap.day_map_id, newNodeIDs)
      && await activeDayPlanExists(client, dayMap.day_map_id, plan.rulesHash)) {
    return {
      generated: false,
      reason: 'already_generated',
      dayMapID: dayMap.day_map_id,
      mapDate: validatedMapDate,
      userID: id,
      revision: Number(dayMap.revision),
      generatedNodeIDs: newNodeIDs,
      rules: { name: resolvedRules.name, version: resolvedRules.version, hash: plan.rulesHash },
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

  const initialLearningCandidates = plan.dayGraph.chosenPath.intervals
    .filter((interval) => interval.sourceNodeID)
    .map((interval, index) => ({
      key: interval.candidateKey ?? interval.key,
      candidateKey: interval.candidateKey ?? interval.key,
      decisionGroup: interval.metadata?.decisionGroup ?? interval.candidateKey ?? interval.key,
      kind: interval.intervalKind,
      sourceNodeID: interval.sourceNodeID,
      candidateRank: index,
      wasEligible: true,
      selectedByChosenRoute: true,
      completionProbability: interval.metadata?.completionProbability ?? 0.65,
      predictedProgressPoints: interval.potentialPoints ?? null,
      durationSeconds: Math.max(1, interval.endSecond - interval.startSecond),
      earliestStartSecond: interval.startSecond,
      latestEndSecond: interval.endSecond,
      fixedStartSecond: interval.startSecond,
      progressCategory: interval.progressCategory,
      progressWeightHint: interval.progressWeightHint ?? interval.potentialPoints ?? 0,
      required: true,
    }));

  const initialDecisionSecond = Math.max(0, Math.min(86_400, Number(currentDayTimeSeconds) || 0));
  const prediction = await scoreCandidatesForRouting(client, {
    configuredMode: predictionRuntimeMode,
    userID: id,
    dayMap,
    mapDate: validatedMapDate,
    decisionSecond: initialDecisionSecond,
    candidates: initialLearningCandidates,
    routingContext: {
      mode: 'cold-start',
      timeZoneIdentifier: validatedTimeZone,
      decisionType: 'initial_day_plan',
      ...(resolvedRules.dayContext ?? {}),
    },
  });
  const predictedByKey = new Map(
    prediction.candidates.map((candidate) => [String(candidate.candidateKey ?? candidate.key), candidate]),
  );
  plan.dayGraph.chosenPath.intervals = plan.dayGraph.chosenPath.intervals.map((interval) => {
    if (!interval.sourceNodeID) return interval;
    const predicted = predictedByKey.get(String(interval.candidateKey ?? interval.key));
    if (!predicted) return interval;
    return {
      ...interval,
      metadata: {
        ...(interval.metadata ?? {}),
        completionProbability: predicted.completionProbability,
        modelCompletionProbability: predicted.modelCompletionProbability ?? null,
        predictionLevel: predicted.predictionLevel ?? 'legacy',
      },
    };
  });
  plan.dayGraph.chosenPath.expectedProgress = plan.dayGraph.chosenPath.intervals.reduce((total, interval) => (
    total + Number(interval.potentialPoints ?? 0) * Number(
      interval.metadata?.completionProbability
        ?? (interval.intervalKind === 'freeTime' ? 0 : 0.65),
    )
  ), 0);

  const dayPlan = await persistCompiledDayPlan(client, {
    dayMap,
    userID: id,
    mapDate: validatedMapDate,
    algorithmName: 'fifoo-deterministic-day-planner',
    algorithmVersion: 1,
    rulesHash: plan.rulesHash,
    chosenPath: plan.dayGraph.chosenPath,
    alternativeBranches: plan.dayGraph.alternativeBranches,
    routingContext: {
      mode: 'cold-start',
      timeZoneIdentifier: validatedTimeZone,
      populationPriorFallback: 0.65,
      ...(resolvedRules.dayContext ?? {}),
    },
    decisionSummary: {
      generatedStopCount: plan.nodes.length,
      fullDayIntervalCount: plan.dayGraph.chosenPath.intervals.length,
      expectedProgress: plan.dayGraph.chosenPath.expectedProgress,
      predictionMode: prediction.predictionMode,
      predictionModel: prediction.model,
    },
  });

  const scoredLearningCandidates = prediction.candidates.map((candidate) => ({
    ...candidate,
    selectedByChosenRoute: true,
  }));

  const learningDecision = await captureRoutingDecision(client, {
    planID: dayPlan.planID,
    planRevision: dayPlan.planRevision,
    dayMap,
    userID: id,
    mapDate: validatedMapDate,
    timeZoneIdentifier: validatedTimeZone,
    decisionType: 'initial_day_plan',
    decisionSecond: initialDecisionSecond,
    algorithmName: 'fifoo-deterministic-day-planner',
    algorithmVersion: 1,
    rulesHash: plan.rulesHash,
    predictionMode: prediction.predictionMode,
    predictionModelName: prediction.model?.name ?? 'completion-prior-blend',
    predictionModelVersion: prediction.model?.version ?? 1,
    routingContext: {
      mode: 'cold-start',
      timeZoneIdentifier: validatedTimeZone,
      ...(resolvedRules.dayContext ?? {}),
    },
    candidates: scoredLearningCandidates,
    routes: [routeObservation(plan.dayGraph.chosenPath, 0, { selected: true, routeKind: 'chosen' })],
  });
  await linkPredictionScoreRun(
    client,
    prediction.predictionScoreRunIDs?.length ? prediction.predictionScoreRunIDs : prediction.predictionScoreRunID,
    learningDecision.decisionEventID,
  );

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
    [dayMap.day_map_id, id, resolvedRules.name, resolvedRules.version, plan.rulesHash, newNodeIDs],
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
    dayPlan,
    rules: { name: resolvedRules.name, version: resolvedRules.version, hash: plan.rulesHash },
  };
}
