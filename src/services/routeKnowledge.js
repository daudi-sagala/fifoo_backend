import { GameError } from '../lib/errors.js';
import { bumpRevision, ensureDayMap } from './dayMaps.js';
import { rerouteFutureDayPlan } from './dayPlanning.js';

const DAY_END_SECOND = 86_400;
const SOURCE = 'road_encounter_self_report';

function option(id, title, subtitle, symbol, value) {
  return { id, title, subtitle, symbol, value };
}

export const ROUTE_KNOWLEDGE_QUESTIONS = Object.freeze([
  {
    key: 'work_structure', version: 1, knowledgeKey: 'work_structure', style: 'road_encounter',
    category: 'schedule', priority: 100, rewardXP: 10, selectionMode: 'single', maxSelections: 1,
    accent: 'royalPurple', icon: 'map.fill',
    title: 'LEARN YOUR TERRITORY', prompt: 'What does your usual workday look like?',
    helperText: 'I’ll protect the hours that belong to work and plan the rest of your march around them.',
    routeImpact: 'work_schedule',
    options: [
      option('early_shift', 'Early March', 'Usually around 6 AM–2 PM', 'sunrise.fill', { type: 'fixed', startTime: '06:00', endTime: '14:00' }),
      option('day_shift', 'The 9-to-5', 'Mostly daytime work', 'building.2.fill', { type: 'fixed', startTime: '09:00', endTime: '17:00' }),
      option('evening_shift', 'Late March', 'Usually around 3 PM–11 PM', 'sunset.fill', { type: 'fixed', startTime: '15:00', endTime: '23:00' }),
      option('night_shift', 'Night Watch', 'Overnight / third shift', 'moon.stars.fill', { type: 'fixed', startTime: '23:00', endTime: '07:00' }),
      option('rotating', 'Shifting Ground', 'My shifts rotate', 'arrow.triangle.2.circlepath', { type: 'rotating' }),
      option('variable', 'Wild Card', 'Every day can be different', 'shuffle', { type: 'variable' }),
      option('none', 'Open Road', 'No regular work schedule', 'road.lanes', { type: 'none' }),
    ],
  },
  {
    key: 'sleep_pattern', version: 1, knowledgeKey: 'sleep_pattern', style: 'road_encounter',
    category: 'recovery', priority: 96, rewardXP: 10, selectionMode: 'single', maxSelections: 1,
    accent: 'midnight', icon: 'moon.zzz.fill',
    title: 'CLAIM YOUR REST CAMP', prompt: 'Which sleep road is closest to your normal routine?',
    helperText: 'Sleep becomes protected territory. I’ll place workouts, meals and prep around it.',
    routeImpact: 'sleep_schedule',
    options: [
      option('early_bird', 'Early Bird Trail', 'About 9:30 PM–5:30 AM', 'sunrise.circle.fill', { bedTime: '21:30', wakeTime: '05:30' }),
      option('standard', 'Middle Road', 'About 11 PM–7 AM', 'bed.double.fill', { bedTime: '23:00', wakeTime: '07:00' }),
      option('night_owl', 'Night Owl Road', 'About 1 AM–9 AM', 'moon.fill', { bedTime: '01:00', wakeTime: '09:00' }),
      option('day_sleeper', 'Day Sleeper', 'About 8 AM–4 PM', 'sun.max.fill', { bedTime: '08:00', wakeTime: '16:00' }),
      option('variable', 'Moving Camp', 'My sleep changes a lot', 'sparkles', { variable: true }),
    ],
  },
  {
    key: 'food_allergies', version: 1, knowledgeKey: 'food_allergies', style: 'scout_report',
    category: 'nutrition_safety', priority: 110, rewardXP: 10, selectionMode: 'multiple', maxSelections: 8,
    accent: 'warning', icon: 'shield.lefthalf.filled',
    title: 'SCOUT REPORT · FOOD SAFETY', prompt: 'Any food allergies Fifoo should treat as hard constraints?',
    helperText: 'Choose every allergy that applies. I will never infer this from your behavior.',
    safetyNote: 'This is self-reported routing information, not medical advice. Always verify ingredients and food preparation yourself.',
    routeImpact: 'safety_constraint',
    options: [
      option('none', 'None', 'No known food allergies', 'checkmark.shield.fill', { key: 'none' }),
      option('peanuts', 'Peanuts', null, 'exclamationmark.triangle.fill', { key: 'peanuts' }),
      option('tree_nuts', 'Tree nuts', null, 'exclamationmark.triangle.fill', { key: 'tree_nuts' }),
      option('milk', 'Milk / dairy', null, 'drop.fill', { key: 'milk' }),
      option('eggs', 'Eggs', null, 'circle.fill', { key: 'eggs' }),
      option('shellfish', 'Shellfish', null, 'fish.fill', { key: 'shellfish' }),
      option('fish', 'Fish', null, 'fish.fill', { key: 'fish' }),
      option('wheat', 'Wheat', null, 'leaf.fill', { key: 'wheat' }),
      option('soy', 'Soy', null, 'leaf.fill', { key: 'soy' }),
      option('sesame', 'Sesame', null, 'circle.grid.3x3.fill', { key: 'sesame' }),
      option('other', 'Something else', 'Saved as a constraint; you can refine it later', 'plus.circle.fill', { key: 'other' }),
    ],
  },
  {
    key: 'diet_style', version: 1, knowledgeKey: 'diet_style', style: 'road_encounter',
    category: 'nutrition', priority: 88, rewardXP: 8, selectionMode: 'single', maxSelections: 1,
    accent: 'green', icon: 'leaf.fill',
    title: 'CHOOSE YOUR FOOD ROAD', prompt: 'Which eating style best describes you?',
    helperText: 'This helps rank meal candidates. You can change it whenever your routine changes.',
    routeImpact: 'meal_filter',
    options: [
      option('omnivore', 'No special style', 'I eat a broad range of foods', 'fork.knife', { key: 'omnivore' }),
      option('vegetarian', 'Vegetarian', null, 'leaf.fill', { key: 'vegetarian' }),
      option('vegan', 'Vegan', null, 'carrot.fill', { key: 'vegan' }),
      option('pescatarian', 'Pescatarian', null, 'fish.fill', { key: 'pescatarian' }),
      option('low_carb', 'Lower carb', null, 'chart.bar.fill', { key: 'low_carb' }),
      option('other', 'My own road', 'Something else / flexible', 'ellipsis.circle.fill', { key: 'other' }),
    ],
  },
  {
    key: 'schedule_predictability', version: 1, knowledgeKey: 'schedule_predictability', style: 'quick_duel',
    category: 'schedule', priority: 80, rewardXP: 5, selectionMode: 'single', maxSelections: 1,
    accent: 'orange', icon: 'bolt.fill', title: 'QUICK DUEL', prompt: 'Is tomorrow usually predictable?',
    helperText: 'This tells me how aggressively to pre-plan versus keep alternate paths open.', routeImpact: 'routing_preference',
    options: [
      option('predictable', 'Mostly predictable', 'Plan ahead', 'calendar.badge.checkmark', { key: 'predictable' }),
      option('variable', 'Usually changes', 'Keep options open', 'shuffle', { key: 'variable' }),
    ],
  },
  {
    key: 'gym_access', version: 1, knowledgeKey: 'gym_access', style: 'quick_duel',
    category: 'exercise', priority: 76, rewardXP: 5, selectionMode: 'single', maxSelections: 1,
    accent: 'blue', icon: 'dumbbell.fill', title: 'QUICK DUEL', prompt: 'Do you have reliable gym access?',
    helperText: 'One tap saves me from sending gym-only workouts down the wrong road.', routeImpact: 'workout_filter',
    options: [
      option('yes', 'YES · Gym road', null, 'dumbbell.fill', { available: true }),
      option('no', 'NO · Anywhere road', null, 'house.fill', { available: false }),
    ],
  },
  {
    key: 'cooking_frequency', version: 1, knowledgeKey: 'cooking_frequency', style: 'scout_report',
    category: 'nutrition', priority: 72, rewardXP: 7, selectionMode: 'single', maxSelections: 1,
    accent: 'amber', icon: 'frying.pan.fill', title: 'SCOUT REPORT · HOME BASE', prompt: 'How often do you realistically cook at home?',
    helperText: 'I can schedule groceries and prep only when they actually have a chance to happen.', routeImpact: 'support_planning',
    options: [
      option('most_days', 'Most days', 'Home cooking is normal for me', 'house.fill', { frequency: 'most_days' }),
      option('few_days', 'A few days a week', 'Mix of home and away', 'calendar', { frequency: 'few_days' }),
      option('rarely', 'Rarely', 'Keep prep routes light', 'takeoutbag.and.cup.and.straw.fill', { frequency: 'rarely' }),
    ],
  },
  {
    key: 'commute_pattern', version: 1, knowledgeKey: 'commute_pattern', style: 'scout_report',
    category: 'logistics', priority: 68, rewardXP: 7, selectionMode: 'single', maxSelections: 1,
    accent: 'teal', icon: 'location.fill', title: 'SCOUT REPORT · TRAVEL', prompt: 'How much time does a normal one-way commute take?',
    helperText: 'Travel time can become protected route space instead of invisible schedule friction.', routeImpact: 'travel_buffer',
    options: [
      option('remote', 'No commute / remote', null, 'house.laptop.fill', { minutes: 0 }),
      option('short', '15 minutes or less', null, 'figure.walk', { minutes: 15 }),
      option('medium', '15–30 minutes', null, 'car.fill', { minutes: 30 }),
      option('long', '30–60 minutes', null, 'car.side.fill', { minutes: 60 }),
      option('very_long', 'More than an hour', null, 'road.lanes', { minutes: 90 }),
    ],
  },
  {
    key: 'workout_time_preference', version: 1, knowledgeKey: 'workout_time_preference', style: 'quick_duel',
    category: 'exercise', priority: 62, rewardXP: 5, selectionMode: 'single', maxSelections: 1,
    accent: 'pink', icon: 'figure.run', title: 'QUICK DUEL', prompt: 'When does exercise feel most realistic?',
    helperText: 'Preference is not a hard rule; it nudges route ranking.', routeImpact: 'routing_preference',
    options: [
      option('morning', 'Morning', null, 'sunrise.fill', { key: 'morning' }),
      option('later', 'Later in the day', null, 'sunset.fill', { key: 'later' }),
      option('flexible', 'Whenever it fits', null, 'arrow.left.arrow.right', { key: 'flexible' }),
    ],
  },
  {
    key: 'meal_pattern', version: 1, knowledgeKey: 'meal_pattern', style: 'scout_report',
    category: 'nutrition', priority: 58, rewardXP: 6, selectionMode: 'single', maxSelections: 1,
    accent: 'green', icon: 'fork.knife.circle.fill', title: 'SCOUT REPORT · FUEL', prompt: 'What meal rhythm is closest to real life?',
    helperText: 'This improves fasting tiles and meal-window planning.', routeImpact: 'meal_timing',
    options: [
      option('two', 'Usually 2 meals', null, '2.circle.fill', { mealsPerDay: 2 }),
      option('three', 'Usually 3 meals', null, '3.circle.fill', { mealsPerDay: 3 }),
      option('three_snacks', '3 meals + snacks', null, 'fork.knife', { mealsPerDay: 3, snacks: true }),
      option('variable', 'It varies a lot', null, 'shuffle', { variable: true }),
    ],
  },
  {
    key: 'weekend_structure', version: 1, knowledgeKey: 'weekend_structure', style: 'quick_duel',
    category: 'schedule', priority: 50, rewardXP: 5, selectionMode: 'single', maxSelections: 1,
    accent: 'purple', icon: 'calendar', title: 'QUICK DUEL', prompt: 'Are weekends a different world?',
    helperText: 'I can learn separate weekday and weekend route patterns.', routeImpact: 'routing_preference',
    options: [
      option('similar', 'Pretty similar', null, 'equal.circle.fill', { key: 'similar' }),
      option('different', 'Completely different', null, 'arrow.triangle.branch', { key: 'different' }),
    ],
  },
  {
    key: 'groceries_readiness', version: 1, knowledgeKey: 'groceries_readiness', style: 'quick_duel',
    category: 'support', priority: 44, rewardXP: 5, selectionMode: 'single', maxSelections: 1,
    accent: 'amber', icon: 'cart.fill', title: 'QUICK DUEL', prompt: 'When you plan to cook, are groceries usually already home?',
    helperText: 'This helps the Scout decide whether to place a grocery stop before meal prep.', routeImpact: 'support_planning',
    options: [
      option('usually', 'Usually ready', null, 'checkmark.circle.fill', { key: 'usually' }),
      option('sometimes', 'Sometimes', null, 'questionmark.circle.fill', { key: 'sometimes' }),
      option('rarely', 'Usually need a store run', null, 'cart.fill', { key: 'rarely' }),
    ],
  },
]);

const QUESTION_BY_KEY = new Map(ROUTE_KNOWLEDGE_QUESTIONS.map((question) => [question.key, question]));

export function encounterCooldownSeconds(answeredCount) {
  if (answeredCount <= 0) return 0;
  if (answeredCount <= 2) return 2 * 3600;
  if (answeredCount <= 5) return 12 * 3600;
  if (answeredCount <= 8) return 24 * 3600;
  return 72 * 3600;
}

export function rankRouteKnowledgeQuestions({ knownKeys = [], answeredCount = 0 } = {}) {
  const known = new Set(knownKeys.map(String));
  const newPlayerBoost = Math.max(0, 18 - answeredCount * 3);
  return ROUTE_KNOWLEDGE_QUESTIONS
    .filter((question) => !known.has(question.knowledgeKey))
    .map((question) => ({ ...question, score: question.priority + (question.style === 'road_encounter' ? newPlayerBoost : 0) }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

function publicQuestion(question, encounterID, knowledgePercentBefore) {
  return {
    schema: 'fifoo.route-knowledge-encounter.v1',
    encounterID,
    questionKey: question.key,
    questionVersion: question.version,
    knowledgeKey: question.knowledgeKey,
    style: question.style,
    category: question.category,
    accent: question.accent,
    icon: question.icon,
    title: question.title,
    prompt: question.prompt,
    helperText: question.helperText ?? null,
    safetyNote: question.safetyNote ?? null,
    selectionMode: question.selectionMode,
    maxSelections: question.maxSelections,
    rewardXP: question.rewardXP,
    routeImpact: question.routeImpact,
    canDefer: true,
    knowledgePercentBefore,
    options: question.options.map(({ value, ...display }) => display),
  };
}

function seconds(clock) {
  if (!clock) return null;
  const match = String(clock).match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60;
}

function sleepWindows(wakeSecond, sleepSecond) {
  if (!Number.isFinite(wakeSecond) || !Number.isFinite(sleepSecond)) return [];
  if (sleepSecond >= wakeSecond) {
    return [
      ...(wakeSecond > 0 ? [{ startSecond: 0, endSecond: wakeSecond, reason: 'sleep' }] : []),
      ...(sleepSecond < DAY_END_SECOND ? [{ startSecond: sleepSecond, endSecond: DAY_END_SECOND, reason: 'sleep' }] : []),
    ];
  }
  return [{ startSecond: sleepSecond, endSecond: wakeSecond, reason: 'sleep' }];
}

function workWindows(value) {
  if (value?.type !== 'fixed') return [];
  const start = seconds(value.startTime);
  const end = seconds(value.endTime);
  if (start == null || end == null || start === end) return [];
  if (end > start) return [{ startSecond: start, endSecond: end, reason: 'work' }];
  return [
    { startSecond: 0, endSecond: end, reason: 'work' },
    { startSecond: start, endSecond: DAY_END_SECOND, reason: 'work' },
  ];
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function intervalKey(interval) {
  return String(interval?.candidateKey ?? interval?.key ?? interval?.intervalID ?? 'candidate');
}

function decisionGroup(interval) {
  return String(interval?.metadata?.decisionGroup ?? intervalKey(interval));
}

function rerouteCandidatesFromPlan(dayPlan, decisionSecond, hardBusyIntervals = []) {
  const chosen = dayPlan?.chosenPath?.intervals ?? [];
  const alternatives = (dayPlan?.alternativeBranches ?? []).flatMap((path) => path?.intervals ?? []);
  const chosenGroups = new Set(chosen.filter((interval) => interval?.sourceNodeID && interval.endSecond > decisionSecond).map(decisionGroup));
  const seen = new Set();
  const result = [];

  for (const interval of [...chosen, ...alternatives]) {
    if (!interval?.sourceNodeID || Number(interval.endSecond) <= decisionSecond) continue;
    const key = intervalKey(interval);
    const dedupe = `${key}:${interval.sourceNodeID}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const start = Number(interval.startSecond);
    const end = Number(interval.endSecond);
    const durationSeconds = Math.max(1, end - start);
    const conflicts = hardBusyIntervals.some((busy) => overlaps(start, end, busy.startSecond, busy.endSecond));
    const workOnlyConflict = conflicts && hardBusyIntervals
      .filter((busy) => overlaps(start, end, busy.startSecond, busy.endSecond))
      .every((busy) => busy.reason === 'work');
    const shouldMove = conflicts && !(workOnlyConflict && interval.intervalKind === 'meal');

    result.push({
      key,
      candidateKey: key,
      decisionGroup: decisionGroup(interval),
      kind: interval.intervalKind ?? 'task',
      intervalKind: interval.intervalKind ?? 'task',
      sourceNodeID: interval.sourceNodeID,
      required: chosenGroups.has(decisionGroup(interval)),
      fixedStartSecond: shouldMove ? null : start,
      earliestStartSecond: shouldMove ? Math.max(decisionSecond + 60, 0) : start,
      latestEndSecond: shouldMove ? DAY_END_SECOND : end,
      durationSeconds,
      progressCategory: interval.progressCategory ?? 'routine',
      progressWeightHint: Math.max(0.0001, Number(interval.progressWeightHint ?? interval.potentialPoints ?? 1)),
      completionProbability: Number(interval.metadata?.completionProbability ?? 0.65),
      completionEvaluator: interval.completionEvaluator ?? { type: 'binary' },
      metabolicContext: interval.metabolicContext ?? null,
      metadata: {
        ...(interval.metadata ?? {}),
        routeKnowledgeUpdate: true,
        movedForKnowledgeConstraint: shouldMove,
        originalStartSecond: start,
        originalEndSecond: end,
      },
    });
  }
  return result.sort((a, b) => a.earliestStartSecond - b.earliestStartSecond || a.key.localeCompare(b.key));
}

async function knownKnowledgeKeys(client, userID) {
  const result = await client.query('SELECT knowledge_key FROM user_route_knowledge WHERE user_id=$1', [userID]);
  const keys = new Set(result.rows.map((row) => String(row.knowledge_key)));
  const schedules = await client.query(
    `SELECT schedule_key FROM user_schedule_preferences
      WHERE user_id=$1 AND schedule_key IN ('work','wake','bed')`,
    [userID],
  );
  const scheduleKeys = new Set(schedules.rows.map((row) => String(row.schedule_key)));
  if (scheduleKeys.has('work')) keys.add('work_structure');
  if (scheduleKeys.has('wake') && scheduleKeys.has('bed')) keys.add('sleep_pattern');
  return [...keys];
}

async function encounterStats(client, userID) {
  const result = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status='answered')::int AS answered_count,
       MAX(answered_at) FILTER (WHERE status='answered') AS last_answered_at
     FROM route_knowledge_encounters WHERE user_id=$1`,
    [userID],
  );
  return {
    answeredCount: Number(result.rows[0]?.answered_count ?? 0),
    lastAnsweredAt: result.rows[0]?.last_answered_at ? new Date(result.rows[0].last_answered_at) : null,
  };
}

async function activeOfferedEncounter(client, userID) {
  const result = await client.query(
    `SELECT encounter_id,question_snapshot,presented_at,status,deferred_until
       FROM route_knowledge_encounters
      WHERE user_id=$1 AND (
        (status='offered' AND presented_at > NOW() - INTERVAL '45 minutes')
        OR (status='deferred' AND deferred_until IS NOT NULL AND deferred_until <= NOW())
      )
      ORDER BY updated_at DESC LIMIT 1`,
    [userID],
  );
  const row = result.rows[0] ?? null;
  if (row?.status === 'deferred') {
    await client.query(
      `UPDATE route_knowledge_encounters SET status='offered',presented_at=NOW(),updated_at=NOW()
        WHERE encounter_id=$1`,
      [row.encounter_id],
    );
  }
  return row;
}

async function hasFutureDeferral(client, userID) {
  const result = await client.query(
    `SELECT 1 FROM route_knowledge_encounters
      WHERE user_id=$1 AND status='deferred' AND deferred_until > NOW() LIMIT 1`,
    [userID],
  );
  return result.rowCount > 0;
}

async function isGoodEncounterMoment(client, userID, mapDate, nowSecond) {
  const result = await client.query(
    `SELECT v.graph_data
       FROM day_maps d
       JOIN day_plan_versions v ON v.day_map_id=d.day_map_id AND v.plan_status='active'
      WHERE d.user_id=$1 AND d.map_date=$2::date
      ORDER BY v.plan_revision DESC LIMIT 1`,
    [userID, mapDate],
  );
  const intervals = result.rows[0]?.graph_data?.chosenPath?.intervals ?? [];
  const active = intervals.find((interval) => interval?.sourceNodeID
    && Number(interval.startSecond) <= nowSecond && Number(interval.endSecond) > nowSecond);
  if (active) return false;
  const next = intervals.find((interval) => interval?.sourceNodeID && Number(interval.startSecond) > nowSecond);
  return !next || Number(next.startSecond) - nowSecond > 5 * 60;
}

export async function selectRouteKnowledgeEncounter(client, {
  userID, mapDate, nowSecond = 0, now = new Date(),
} = {}) {
  const offered = await activeOfferedEncounter(client, userID);
  if (offered?.question_snapshot) return offered.question_snapshot;
  if (await hasFutureDeferral(client, userID)) return null;

  const [keys, stats] = await Promise.all([knownKnowledgeKeys(client, userID), encounterStats(client, userID)]);
  const cooldown = encounterCooldownSeconds(stats.answeredCount);
  if (stats.lastAnsweredAt && now.getTime() - stats.lastAnsweredAt.getTime() < cooldown * 1000) return null;
  if (!await isGoodEncounterMoment(client, userID, mapDate, nowSecond)) return null;

  const question = rankRouteKnowledgeQuestions({ knownKeys: keys, answeredCount: stats.answeredCount })[0];
  if (!question) return null;
  const knowledgePercentBefore = Math.round((keys.length / ROUTE_KNOWLEDGE_QUESTIONS.length) * 100);
  const inserted = await client.query(
    `INSERT INTO route_knowledge_encounters(
       user_id,map_date,question_key,question_version,encounter_style,status,question_snapshot,trigger_context,reward_xp
     ) VALUES ($1,$2::date,$3,$4,$5,'offered','{}'::jsonb,$6::jsonb,$7)
     RETURNING encounter_id`,
    [userID, mapDate, question.key, question.version, question.style,
      JSON.stringify({ answeredCount: stats.answeredCount, knowledgePercentBefore, nowSecond }), question.rewardXP],
  );
  const payload = publicQuestion(question, inserted.rows[0].encounter_id, knowledgePercentBefore);
  await client.query(
    'UPDATE route_knowledge_encounters SET question_snapshot=$2::jsonb,updated_at=NOW() WHERE encounter_id=$1',
    [inserted.rows[0].encounter_id, JSON.stringify(payload)],
  );
  return payload;
}

async function upsertKnowledge(client, userID, knowledgeKey, value) {
  await client.query(
    `INSERT INTO user_route_knowledge(user_id,knowledge_key,knowledge_value,confidence,source,observed_at,updated_at)
     VALUES ($1,$2,$3::jsonb,1,$4,NOW(),NOW())
     ON CONFLICT(user_id,knowledge_key) DO UPDATE SET
       knowledge_value=EXCLUDED.knowledge_value,confidence=1,source=EXCLUDED.source,observed_at=NOW(),updated_at=NOW()`,
    [userID, knowledgeKey, JSON.stringify(value), SOURCE],
  );
}

async function upsertSchedule(client, userID, scheduleKey, fields = {}) {
  await client.query(
    `INSERT INTO user_schedule_preferences(
       user_id,schedule_key,clock_time,start_time,end_time,flexibility_minutes,is_fixed,source,preference_data,updated_at
     ) VALUES ($1,$2,$3::time,$4::time,$5::time,$6,$7,$8,$9::jsonb,NOW())
     ON CONFLICT(user_id,schedule_key) DO UPDATE SET
       clock_time=EXCLUDED.clock_time,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,
       flexibility_minutes=EXCLUDED.flexibility_minutes,is_fixed=EXCLUDED.is_fixed,source=EXCLUDED.source,
       preference_data=EXCLUDED.preference_data,updated_at=NOW()`,
    [userID, scheduleKey, fields.clockTime ?? null, fields.startTime ?? null, fields.endTime ?? null,
      fields.flexibilityMinutes ?? 30, fields.isFixed === true, SOURCE, JSON.stringify(fields.preferenceData ?? {})],
  );
}

async function mirrorStructuredKnowledge(client, userID, question, selectedValues) {
  if (question.key === 'work_structure') {
    const value = selectedValues[0] ?? {};
    await upsertSchedule(client, userID, 'work', {
      startTime: value.type === 'fixed' ? value.startTime : null,
      endTime: value.type === 'fixed' ? value.endTime : null,
      isFixed: value.type === 'fixed',
      flexibilityMinutes: value.type === 'fixed' ? 15 : 180,
      preferenceData: value,
    });
  }
  if (question.key === 'sleep_pattern') {
    const value = selectedValues[0] ?? {};
    await upsertSchedule(client, userID, 'bed', {
      clockTime: value.variable ? null : value.bedTime,
      isFixed: !value.variable,
      flexibilityMinutes: value.variable ? 180 : 45,
      preferenceData: value,
    });
    await upsertSchedule(client, userID, 'wake', {
      clockTime: value.variable ? null : value.wakeTime,
      isFixed: !value.variable,
      flexibilityMinutes: value.variable ? 180 : 45,
      preferenceData: value,
    });
  }
}

async function scheduleContext(client, userID) {
  const rows = await client.query(
    `SELECT schedule_key,clock_time::text,start_time::text,end_time::text,is_fixed,preference_data
       FROM user_schedule_preferences
      WHERE user_id=$1 AND schedule_key IN ('wake','bed','work')`,
    [userID],
  );
  const byKey = new Map(rows.rows.map((row) => [row.schedule_key, row]));
  const wakeSecond = seconds(byKey.get('wake')?.clock_time?.slice(0, 5));
  const sleepSecond = seconds(byKey.get('bed')?.clock_time?.slice(0, 5));
  const sleep = sleepWindows(wakeSecond, sleepSecond);
  const workValue = byKey.get('work')?.preference_data ?? null;
  const work = workWindows(workValue);
  return {
    wakeSecond: wakeSecond ?? 7 * 3600,
    sleepSecond: sleepSecond ?? 23 * 3600,
    sleepWindows: sleep,
    workBusyIntervals: work,
    hardBusyIntervals: [...sleep, ...work],
  };
}

async function activePlan(client, dayMapID) {
  const result = await client.query(
    `SELECT plan_id,plan_revision,graph_data,routing_context,algorithm_name,algorithm_version,rules_hash
       FROM day_plan_versions WHERE day_map_id=$1 AND plan_status='active'
      ORDER BY plan_revision DESC LIMIT 1 FOR UPDATE`,
    [dayMapID],
  );
  return result.rows[0] ?? null;
}

async function rerouteForKnowledge(client, {
  userID, mapDate, timeZoneIdentifier, decisionSecond, routeImpact, predictionRuntimeMode,
} = {}) {
  if (!['work_schedule', 'sleep_schedule'].includes(routeImpact)) return null;
  const dayMap = await ensureDayMap(client, { userID, mapDate, timeZoneIdentifier });
  const active = await activePlan(client, dayMap.day_map_id);
  if (!active?.graph_data?.chosenPath?.intervals) return null;
  const context = await scheduleContext(client, userID);
  const boundary = Math.max(1, Math.min(DAY_END_SECOND - 1, Math.trunc(Number(decisionSecond) || 1)));
  const candidates = rerouteCandidatesFromPlan(active.graph_data, boundary, context.hardBusyIntervals);
  if (!candidates.length) return null;
  const result = await rerouteFutureDayPlan(client, {
    dayMap,
    userID,
    mapDate,
    decisionSecond: boundary,
    candidates,
    rerouteReason: 'route_knowledge_updated',
    routingContext: {
      ...(active.routing_context ?? {}),
      mode: 'route-knowledge-update',
      timeZoneIdentifier,
      wakeSecond: context.wakeSecond,
      sleepSecond: context.sleepSecond,
      sleepWindows: context.sleepWindows,
      hardBusyIntervals: context.hardBusyIntervals,
      routeKnowledgeImpact: routeImpact,
    },
    algorithmName: active.algorithm_name ?? 'fifoo-deterministic-router',
    algorithmVersion: Number(active.algorithm_version ?? 2),
    rulesHash: active.rules_hash ?? null,
    alternativeCount: 2,
    timeZoneIdentifier,
    predictionRuntimeMode,
  });
  const revision = await bumpRevision(client, dayMap.day_map_id);
  return {
    revision,
    dayPlanState: {
      dayPlan: result.dayPlan,
      progressSnapshot: result.progressSnapshot,
      planRevision: result.planRevision,
      revision,
      rerouteReason: result.rerouteReason,
      effectiveAt: result.effectiveAt,
      decisionSecond: result.decisionSecond,
    },
  };
}

function feedbackFor(question, selectedOptions, routeUpdated) {
  const label = selectedOptions.map((item) => item.title).join(', ');
  if (question.key === 'work_structure') return ['TERRITORY MAPPED', routeUpdated ? 'Work hours are now protected and the future route has been redrawn.' : `Work pattern saved: ${label}.`];
  if (question.key === 'sleep_pattern') return ['REST CAMP CLAIMED', routeUpdated ? 'Sleep is protected territory and today’s future route has been rebuilt around it.' : `Sleep pattern saved: ${label}.`];
  if (question.key === 'food_allergies') return ['SAFETY INTEL LOCKED', 'Food-allergy constraints are now part of meal-route filtering.'];
  if (question.key === 'diet_style') return ['FOOD ROAD UNLOCKED', 'Future meal candidates can now be ranked against your eating style.'];
  if (question.key === 'gym_access') return ['TRAINING TERRAIN KNOWN', 'Workout routes can now avoid equipment you do not reliably have.'];
  if (question.routeImpact === 'support_planning') return ['SCOUT INTEL SAVED', 'Prep and grocery planning now has better context.'];
  return ['ROUTE KNOWLEDGE +1', `${label} is now part of your routing profile.`];
}

export async function answerRouteKnowledgeEncounter(client, {
  userID, encounterID, optionIDs, mapDate, timeZoneIdentifier, decisionSecond = 0, predictionRuntimeMode = 'legacy',
} = {}) {
  const row = await client.query(
    `SELECT * FROM route_knowledge_encounters WHERE encounter_id=$1 AND user_id=$2 FOR UPDATE`,
    [encounterID, userID],
  );
  if (!row.rowCount) throw new GameError('not_found', 'This route encounter no longer exists.');
  const encounter = row.rows[0];
  if (encounter.status === 'answered') {
    return { result: encounter.answer_data?.result ?? null, dayPlanState: null, alreadyAnswered: true };
  }
  if (!['offered', 'deferred'].includes(encounter.status)) throw new GameError('conflict', 'This route encounter is no longer answerable.');

  const question = QUESTION_BY_KEY.get(String(encounter.question_key));
  if (!question) throw new GameError('conflict', 'This route encounter uses an unsupported question version.');
  const ids = [...new Set((Array.isArray(optionIDs) ? optionIDs : []).map(String))];
  if (!ids.length || ids.length > question.maxSelections) throw new GameError('invalid_payload', 'Choose a valid answer.');
  if (question.selectionMode === 'single' && ids.length !== 1) throw new GameError('invalid_payload', 'Choose one answer.');
  if (question.key === 'food_allergies' && ids.includes('none') && ids.length > 1) {
    throw new GameError('invalid_payload', '“None” cannot be combined with an allergy.');
  }
  const selected = ids.map((id) => question.options.find((candidate) => candidate.id === id));
  if (selected.some((candidate) => !candidate)) throw new GameError('invalid_payload', 'Unknown answer choice.');
  const selectedValues = selected.map((candidate) => candidate.value);
  const knowledgeValue = question.selectionMode === 'multiple'
    ? { selections: selectedValues, optionIDs: ids }
    : { ...selectedValues[0], optionID: ids[0] };

  await upsertKnowledge(client, userID, question.knowledgeKey, knowledgeValue);
  await mirrorStructuredKnowledge(client, userID, question, selectedValues);

  let reroute = null;
  try {
    reroute = await rerouteForKnowledge(client, {
      userID, mapDate, timeZoneIdentifier, decisionSecond, routeImpact: question.routeImpact, predictionRuntimeMode,
    });
  } catch (error) {
    // Knowledge is still valid even if current-day rerouting is temporarily impossible.
    reroute = null;
  }

  const keys = await knownKnowledgeKeys(client, userID);
  const knowledgePercent = Math.round((keys.length / ROUTE_KNOWLEDGE_QUESTIONS.length) * 100);
  const [feedbackTitle, feedbackMessage] = feedbackFor(question, selected, Boolean(reroute));
  const stats = await encounterStats(client, userID);
  const nextEligible = new Date(Date.now() + encounterCooldownSeconds(stats.answeredCount + 1) * 1000).toISOString();
  const result = {
    schema: 'fifoo.route-knowledge-result.v1',
    encounterID,
    questionKey: question.key,
    knowledgeKey: question.knowledgeKey,
    rewardXP: question.rewardXP,
    knowledgePercent,
    routeImpact: question.routeImpact,
    routeUpdated: Boolean(reroute),
    mapDate,
    feedbackTitle,
    feedbackMessage,
    nextEncounterEligibleAt: nextEligible,
  };

  const updated = await client.query(
    `UPDATE route_knowledge_encounters SET
       status='answered',answer_data=$3::jsonb,reward_xp=$4,answered_at=NOW(),updated_at=NOW()
      WHERE encounter_id=$1 AND user_id=$2 AND status IN ('offered','deferred')`,
    [encounterID, userID, JSON.stringify({ optionIDs: ids, knowledgeValue, result }), question.rewardXP],
  );
  if (updated.rowCount) {
    await client.query(
      `INSERT INTO game_xp_ledger(user_id,source_type,source_id,xp,reason,metadata)
       VALUES ($1,'route_knowledge',$2,$3,'Route knowledge acquired',$4::jsonb)`,
      [userID, encounterID, question.rewardXP, JSON.stringify({ questionKey: question.key, knowledgeKey: question.knowledgeKey })],
    );
    await client.query(
      `INSERT INTO user_game_progress(user_id,total_xp,level) VALUES ($1,$2,1)
       ON CONFLICT(user_id) DO UPDATE SET total_xp=user_game_progress.total_xp+$2,updated_at=NOW()`,
      [userID, question.rewardXP],
    );
  }

  return { result, dayPlanState: reroute?.dayPlanState ?? null, revision: reroute?.revision ?? null, alreadyAnswered: false };
}

export async function deferRouteKnowledgeEncounter(client, { userID, encounterID, hours = 6 } = {}) {
  const safeHours = Math.max(1, Math.min(72, Number(hours) || 6));
  const result = await client.query(
    `UPDATE route_knowledge_encounters SET status='deferred',deferred_until=NOW()+($3::text || ' hours')::interval,updated_at=NOW()
      WHERE encounter_id=$1 AND user_id=$2 AND status='offered' RETURNING encounter_id`,
    [encounterID, userID, safeHours],
  );
  if (!result.rowCount) throw new GameError('conflict', 'This route encounter can no longer be deferred.');
  return { encounterID, deferredHours: safeHours };
}
