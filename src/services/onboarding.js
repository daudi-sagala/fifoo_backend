import { GameError } from '../lib/errors.js';
import { standardWeightLossDayRules } from '../rules/standardWeightLossDay.js';
import { buildStandardWeightLossDay, generateDailyPathForUser } from './dailyPathGenerator.js';
import { ensureDayMap, loadSnapshot } from './dayMaps.js';
import { loadAuthoritativeDayPlanState } from './dayPlanning.js';

export const ONBOARDING_VERSION = 1;

export const MAIN_QUESTS = new Set([
  'feel_better', 'confidence', 'fitness', 'family', 'healthy_habits', 'clothes', 'energy',
]);
export const PLAYER_STYLES = new Set(['planner', 'improviser', 'competitor', 'minimalist', 'social']);
export const DIFFICULTIES = new Set(['casual', 'balanced', 'challenge']);
export const OBSTACLES = new Set([
  'late_night_eating', 'takeout', 'weekends', 'poor_sleep', 'low_activity',
  'sugar_cravings', 'busy_workdays', 'travel', 'stress_eating', 'portion_size',
]);
export const POWERUPS = new Set([
  'walking', 'home_cooking', 'strength_training', 'running', 'meal_prep',
  'high_protein_food', 'cycling', 'group_fitness',
]);

const STAGES = new Set(['player_style', 'obstacles', 'powerups', 'difficulty', 'typical_day', 'route_preview']);
const PACE = { casual: 0.5, balanced: 1.0, challenge: 1.5 };

function cleanString(value, max = 120) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function enumValue(value, allowed, field, { optional = false } = {}) {
  const normalized = cleanString(value, 80)?.toLowerCase() ?? null;
  if (optional && !normalized) return null;
  if (!normalized || !allowed.has(normalized)) {
    throw new GameError('invalid_payload', `Invalid onboarding ${field}.`);
  }
  return normalized;
}

function weight(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 70 || number > 700) {
    throw new GameError('invalid_payload', `${field} must be between 70 and 700 lb.`);
  }
  return Math.round(number * 10) / 10;
}

function enumArray(value, allowed, field, max = 8) {
  if (!Array.isArray(value)) throw new GameError('invalid_payload', `${field} must be an array.`);
  const cleaned = [...new Set(value.map((item) => cleanString(item, 80)?.toLowerCase()).filter(Boolean))];
  if (cleaned.length > max || cleaned.some((item) => !allowed.has(item))) {
    throw new GameError('invalid_payload', `Invalid ${field}.`);
  }
  return cleaned;
}

function clock(value, fallback) {
  const text = cleanString(value, 5) ?? fallback;
  const match = String(text).match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new GameError('invalid_payload', `Invalid clock time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new GameError('invalid_payload', `Invalid clock time: ${value}`);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function clockMinutes(clockValue) {
  const [h, m] = clockValue.split(':').map(Number);
  return h * 60 + m;
}

function clockFromMinutes(value) {
  const total = Math.max(0, Math.min(23 * 60 + 59, Math.trunc(Number(value) || 0)));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function addMinutes(clockValue, minutes) {
  return clockFromMinutes(clockMinutes(clockValue) + Number(minutes));
}

function resolveStopOverlaps(stops) {
  const sorted = [...stops].sort((a, b) => clockMinutes(a.start) - clockMinutes(b.start));
  let cursor = 0;
  return sorted.map((stop) => {
    const duration = Math.max(1, Math.trunc(Number(stop.durationMinutes ?? 0)));
    let start = Math.max(clockMinutes(stop.start), cursor);
    if (start + duration > 23 * 60 + 59) {
      start = Math.max(cursor, 23 * 60 + 59 - duration);
    }
    cursor = start + duration + 5;
    return { ...stop, start: clockFromMinutes(start) };
  });
}

function sessionPayload(row) {
  return row?.session_data && typeof row.session_data === 'object' ? row.session_data : {};
}

async function profileRow(client, userID) {
  const result = await client.query(
    `SELECT * FROM user_game_profiles WHERE user_id=$1`,
    [userID],
  );
  return result.rows[0] ?? null;
}

async function activeSessionRow(client, userID) {
  const result = await client.query(
    `SELECT * FROM onboarding_sessions
      WHERE user_id=$1 AND onboarding_version=$2
      ORDER BY updated_at DESC LIMIT 1`,
    [userID, ONBOARDING_VERSION],
  );
  return result.rows[0] ?? null;
}

export async function initializeNewPlayerProfile(client, userID) {
  await client.query(
    `INSERT INTO user_game_profiles(user_id,onboarding_status,onboarding_version)
     VALUES ($1,'not_started',$2)
     ON CONFLICT(user_id) DO UPDATE SET
       onboarding_status='not_started',onboarding_version=$2,onboarding_completed_at=NULL,updated_at=NOW()`,
    [userID, ONBOARDING_VERSION],
  );
  await client.query(
    `INSERT INTO user_game_progress(user_id) VALUES ($1) ON CONFLICT(user_id) DO NOTHING`,
    [userID],
  );
}

export async function loadOnboardingState(client, userID) {
  const profile = await profileRow(client, userID);
  // Accounts that pre-date Phase 8 are intentionally treated as completed.
  if (!profile) {
    return {
      schema: 'fifoo.onboarding.v1',
      onboardingVersion: ONBOARDING_VERSION,
      status: 'completed_legacy',
      currentStage: null,
      needsOnboarding: false,
      sessionData: {},
      profile: null,
    };
  }
  const session = await activeSessionRow(client, userID);
  return {
    schema: 'fifoo.onboarding.v1',
    onboardingVersion: Number(profile.onboarding_version ?? ONBOARDING_VERSION),
    status: profile.onboarding_status,
    currentStage: session?.current_stage ?? (profile.onboarding_status === 'not_started' ? 'player_style' : null),
    needsOnboarding: !['completed', 'completed_legacy'].includes(profile.onboarding_status),
    firstRouteMapDate: session?.first_route_map_date ?? null,
    sessionData: sessionPayload(session),
    profile: {
      mainQuest: profile.main_quest ?? null,
      playerStyle: profile.player_style ?? null,
      difficulty: profile.difficulty ?? null,
      currentWeightLB: profile.current_weight_lb == null ? null : Number(profile.current_weight_lb),
      goalWeightLB: profile.goal_weight_lb == null ? null : Number(profile.goal_weight_lb),
      targetPaceLBPerWeek: profile.target_pace_lb_per_week == null ? null : Number(profile.target_pace_lb_per_week),
    },
  };
}

export async function startOnboarding(client, { userID, payload = {} } = {}) {
  const currentWeightLB = weight(payload.currentWeightLB, 'Current weight');
  const goalWeightLB = weight(payload.goalWeightLB, 'Goal weight');
  if (goalWeightLB >= currentWeightLB) {
    throw new GameError('invalid_payload', 'For the weight-loss journey, goal weight must be below current weight.');
  }
  const mainQuest = enumValue(payload.mainQuest, MAIN_QUESTS, 'main quest');

  await client.query(
    `INSERT INTO user_game_profiles(
       user_id,onboarding_status,onboarding_version,current_weight_lb,goal_weight_lb,main_quest,primary_motivation
     ) VALUES ($1,'in_progress',$2,$3,$4,$5,$6)
     ON CONFLICT(user_id) DO UPDATE SET
       onboarding_status='in_progress',onboarding_version=$2,current_weight_lb=$3,goal_weight_lb=$4,
       main_quest=$5,primary_motivation=$6,onboarding_completed_at=NULL,updated_at=NOW()`,
    [userID, ONBOARDING_VERSION, currentWeightLB, goalWeightLB, mainQuest, cleanString(payload.mainQuestLabel, 200)],
  );

  const initialData = {
    spawnPoint: { currentWeightLB },
    destination: { goalWeightLB },
    mainQuest,
    mainQuestLabel: cleanString(payload.mainQuestLabel, 200),
  };
  await client.query(
    `INSERT INTO onboarding_sessions(user_id,onboarding_version,current_stage,status,session_data)
     VALUES ($1,$2,'player_style','in_progress',$3::jsonb)
     ON CONFLICT(user_id,onboarding_version) DO UPDATE SET
       current_stage='player_style',status='in_progress',session_data=$3::jsonb,
       first_route_map_date=NULL,completed_at=NULL,updated_at=NOW()`,
    [userID, ONBOARDING_VERSION, JSON.stringify(initialData)],
  );
  return loadOnboardingState(client, userID);
}

export async function updateOnboarding(client, { userID, stage, payload = {} } = {}) {
  const normalizedStage = enumValue(stage, STAGES, 'stage');
  const existing = await activeSessionRow(client, userID);
  if (!existing) throw new GameError('conflict', 'Start onboarding before updating it.');
  if (existing.status === 'completed') return loadOnboardingState(client, userID);

  let stageData;
  switch (normalizedStage) {
    case 'player_style':
      stageData = { playerStyle: enumValue(payload.playerStyle, PLAYER_STYLES, 'player style') };
      break;
    case 'obstacles':
      stageData = { obstacles: enumArray(payload.obstacles ?? [], OBSTACLES, 'obstacles', 6) };
      break;
    case 'powerups':
      stageData = { powerups: enumArray(payload.powerups ?? [], POWERUPS, 'powerups', 6) };
      break;
    case 'difficulty':
      stageData = { difficulty: enumValue(payload.difficulty, DIFFICULTIES, 'difficulty') };
      break;
    case 'typical_day': {
      const wakeTime = clock(payload.wakeTime, '07:00');
      const workStartTime = clock(payload.workStartTime, '09:00');
      const workEndTime = clock(payload.workEndTime, '17:00');
      const lunchTime = clock(payload.lunchTime, '12:30');
      const workoutTime = clock(payload.workoutTime, '17:30');
      const dinnerTime = clock(payload.dinnerTime, '19:00');
      const bedTime = clock(payload.bedTime, '23:00');
      stageData = {
        typicalDay: {
          wakeTime, workStartTime, workEndTime, lunchTime, workoutTime, dinnerTime, bedTime,
          groceriesReady: payload.groceriesReady === true,
        },
      };
      break;
    }
    case 'route_preview':
      stageData = {};
      break;
    default:
      throw new GameError('invalid_payload', 'Unsupported onboarding stage.');
  }

  const merged = { ...sessionPayload(existing), ...stageData };
  const nextStage = {
    player_style: 'obstacles', obstacles: 'powerups', powerups: 'difficulty',
    difficulty: 'typical_day', typical_day: 'route_preview', route_preview: 'route_preview',
  }[normalizedStage];

  await client.query(
    `UPDATE onboarding_sessions SET session_data=$3::jsonb,current_stage=$4,updated_at=NOW()
      WHERE user_id=$1 AND onboarding_version=$2`,
    [userID, ONBOARDING_VERSION, JSON.stringify(merged), nextStage],
  );

  if (stageData.playerStyle) {
    await client.query('UPDATE user_game_profiles SET player_style=$2,updated_at=NOW() WHERE user_id=$1', [userID, stageData.playerStyle]);
  }
  if (stageData.difficulty) {
    await client.query(
      `UPDATE user_game_profiles SET difficulty=$2,target_pace_lb_per_week=$3,
       preferred_intervention_intensity=$4,updated_at=NOW() WHERE user_id=$1`,
      [userID, stageData.difficulty, PACE[stageData.difficulty], stageData.difficulty],
    );
  }
  return loadOnboardingState(client, userID);
}

function workoutStop(powerups, baseStop) {
  if (powerups.includes('strength_training')) {
    return { ...baseStop, title: 'Full-body strength', categories: ['Strength', 'Full Body', 'Weight Loss'] };
  }
  if (powerups.includes('running')) {
    return { ...baseStop, title: 'Easy run', categories: ['Running', 'Cardio', 'Weight Loss'] };
  }
  if (powerups.includes('cycling')) {
    return { ...baseStop, title: 'Easy ride', categories: ['Cycling', 'Cardio', 'Weight Loss'] };
  }
  if (powerups.includes('walking')) {
    return { ...baseStop, title: 'Long walk', categories: ['Walking', 'Cardio', 'Weight Loss'] };
  }
  return { ...baseStop, title: 'Flexible movement session', categories: ['Movement', 'Weight Loss'] };
}

export function personalizedOnboardingRules(sessionData) {
  const rules = structuredClone(standardWeightLossDayRules());
  rules.name = 'onboarding-first-route';
  rules.version = ONBOARDING_VERSION;
  const powerups = Array.isArray(sessionData.powerups) ? sessionData.powerups : [];
  const difficulty = DIFFICULTIES.has(sessionData.difficulty) ? sessionData.difficulty : 'balanced';
  const typical = sessionData.typicalDay ?? {};
  const wake = clock(typical.wakeTime, '07:00');
  const workStart = clock(typical.workStartTime, '09:00');
  const workEnd = clock(typical.workEndTime, '17:00');
  const lunch = clock(typical.lunchTime, '12:30');
  let workout = clock(typical.workoutTime, '17:30');
  const dinner = clock(typical.dinnerTime, '19:00');
  const bed = clock(typical.bedTime, '23:00');
  if (clockMinutes(workout) >= clockMinutes(workStart) && clockMinutes(workout) < clockMinutes(workEnd)) {
    workout = addMinutes(workEnd, 30);
  }

  rules.dayContext = {
    onboardingVersion: ONBOARDING_VERSION,
    playerStyle: sessionData.playerStyle ?? 'planner',
    difficulty,
    selfReportedObstacles: sessionData.obstacles ?? [],
    preferredInterventions: powerups,
  };

  rules.stops = rules.stops.map((stop) => {
    if (stop.key === 'morning-check-in') return { ...stop, start: addMinutes(wake, 5) };
    if (stop.key === 'breakfast') {
      return {
        ...stop,
        start: addMinutes(wake, 30),
        title: powerups.includes('high_protein_food') ? 'Protein power breakfast' : stop.title,
      };
    }
    if (stop.key === 'morning-walk') {
      return {
        ...stop,
        start: addMinutes(wake, 180),
        title: powerups.includes('walking') ? 'Power-up walk' : 'Movement break',
        categories: powerups.includes('walking') ? ['Walking', 'Cardio', 'Weight Loss'] : stop.categories,
      };
    }
    if (stop.key === 'lunch') return { ...stop, start: lunch };
    if (stop.key === 'afternoon-reset') return { ...stop, start: addMinutes(lunch, 180) };
    if (stop.key === 'strength-workout') {
      const durationMinutes = difficulty === 'casual' ? 20 : difficulty === 'challenge' ? 40 : 30;
      return workoutStop(powerups, { ...stop, start: workout, durationMinutes });
    }
    if (stop.key === 'dinner') {
      const homeCooked = powerups.includes('home_cooking');
      return {
        ...stop,
        start: dinner,
        title: homeCooked ? 'Home-cooked dinner' : 'Balanced dinner',
        description: homeCooked
          ? 'Cook a satisfying dinner centered on protein and vegetables. Fifoo can prepare the route ahead of time.'
          : stop.description,
        executionPlan: homeCooked ? {
          source: 'homeMade',
          groceriesNeeded: typical.groceriesReady !== true,
          ingredientsReady: typical.groceriesReady === true,
          shoppingList: [],
        } : undefined,
      };
    }
    if (stop.key === 'tomorrow-prep') return { ...stop, start: addMinutes(bed, -45) };
    return stop;
  });

  // The first route must always be renderable. User-entered times are
  // preferences; if two generated stops collide, move the later stop to the
  // next free slot rather than returning an unusable onboarding preview.
  rules.stops = resolveStopOverlaps(rules.stops);
  return rules;
}

function previewFromRules({ rules, sessionData, mapDate }) {
  return {
    schema: 'fifoo.onboarding-route-preview.v1',
    mapDate,
    title: 'Your first route',
    subtitle: 'A playable Day 1 built from your choices.',
    playerStyle: sessionData.playerStyle ?? 'planner',
    difficulty: sessionData.difficulty ?? 'balanced',
    stops: rules.stops.map((stop, index) => ({
      key: stop.key,
      title: stop.title,
      start: stop.start,
      durationMinutes: Number(stop.durationMinutes ?? 0),
      kind: stop.kind,
      xp: stop.kind === 'workout' ? 25 : stop.kind === 'meal' ? 12 : 10,
      isPowerupMatch: (
        (stop.key === 'morning-walk' && sessionData.powerups?.includes('walking'))
        || (stop.key === 'strength-workout' && ['strength_training','running','cycling','walking'].some((key) => sessionData.powerups?.includes(key)))
        || (stop.key === 'dinner' && sessionData.powerups?.includes('home_cooking'))
      ),
    })),
  };
}

export async function previewOnboardingRoute(client, { userID, mapDate, timeZoneIdentifier } = {}) {
  const session = await activeSessionRow(client, userID);
  if (!session) throw new GameError('conflict', 'Start onboarding before previewing a route.');
  const data = sessionPayload(session);
  if (!data.playerStyle || !data.difficulty || !data.typicalDay) {
    throw new GameError('conflict', 'Finish the onboarding choices before building a route.');
  }
  // Validation side-effect only: proves the personalized rules can compile into a full Day Graph.
  const rules = personalizedOnboardingRules(data);
  buildStandardWeightLossDay({ userID, mapDate, rules });
  await client.query(
    `UPDATE onboarding_sessions SET status='preview_ready',current_stage='route_preview',first_route_map_date=$3,updated_at=NOW()
      WHERE user_id=$1 AND onboarding_version=$2`,
    [userID, ONBOARDING_VERSION, mapDate],
  );
  await client.query(
    `UPDATE user_game_profiles SET onboarding_status='preview_ready',updated_at=NOW() WHERE user_id=$1`,
    [userID],
  );
  return previewFromRules({ rules, sessionData: data, mapDate, timeZoneIdentifier });
}

async function persistSelections(client, userID, data) {
  await client.query('DELETE FROM user_game_obstacles WHERE user_id=$1', [userID]);
  for (const [index, key] of (data.obstacles ?? []).entries()) {
    await client.query(
      `INSERT INTO user_game_obstacles(user_id,obstacle_key,priority,confidence,source)
       VALUES ($1,$2,$3,0.60,'onboarding_self_report')`,
      [userID, key, Math.max(1, 6 - index)],
    );
  }
  await client.query('DELETE FROM user_game_powerups WHERE user_id=$1', [userID]);
  for (const key of (data.powerups ?? [])) {
    await client.query(
      `INSERT INTO user_game_powerups(user_id,powerup_key,preference_strength,source)
       VALUES ($1,$2,0.70,'onboarding_self_report')`,
      [userID, key],
    );
  }

  const typical = data.typicalDay ?? {};
  const rows = [
    ['wake', typical.wakeTime, false, 20], ['work_start', typical.workStartTime, true, 0],
    ['work_end', typical.workEndTime, true, 0], ['lunch', typical.lunchTime, false, 45],
    ['workout', typical.workoutTime, false, 90], ['dinner', typical.dinnerTime, false, 60],
    ['bed', typical.bedTime, false, 30],
  ];
  for (const [key, clockTime, isFixed, flexibility] of rows) {
    if (!clockTime) continue;
    await client.query(
      `INSERT INTO user_schedule_preferences(user_id,schedule_key,clock_time,flexibility_minutes,is_fixed,source,preference_data)
       VALUES ($1,$2,$3::time,$4,$5,'onboarding_self_report','{}'::jsonb)
       ON CONFLICT(user_id,schedule_key) DO UPDATE SET
         clock_time=EXCLUDED.clock_time,flexibility_minutes=EXCLUDED.flexibility_minutes,
         is_fixed=EXCLUDED.is_fixed,source=EXCLUDED.source,updated_at=NOW()`,
      [userID, key, clockTime, flexibility, isFixed],
    );
  }
}

async function awardOnboardingXP(client, userID) {
  const existing = await client.query(
    `SELECT 1 FROM game_xp_ledger WHERE user_id=$1 AND source_type='onboarding' AND source_id=$2 LIMIT 1`,
    [userID, `v${ONBOARDING_VERSION}`],
  );
  if (existing.rowCount) return;
  await client.query(
    `INSERT INTO game_xp_ledger(user_id,source_type,source_id,xp,reason,metadata)
     VALUES ($1,'onboarding',$2,50,'First route built',$3::jsonb)`,
    [userID, `v${ONBOARDING_VERSION}`, JSON.stringify({ controllableBehaviorReward: true })],
  );
  await client.query(
    `INSERT INTO user_game_progress(user_id,total_xp,level) VALUES ($1,50,1)
     ON CONFLICT(user_id) DO UPDATE SET total_xp=user_game_progress.total_xp+50,updated_at=NOW()`,
    [userID],
  );
}

export async function completeOnboarding(client, {
  userID, mapDate, timeZoneIdentifier, currentDayTimeSeconds = 0, predictionRuntimeMode = 'legacy',
} = {}) {
  const session = await activeSessionRow(client, userID);
  if (!session) throw new GameError('conflict', 'Start onboarding before completing it.');
  const data = sessionPayload(session);
  if (!data.playerStyle || !data.difficulty || !data.typicalDay) {
    throw new GameError('conflict', 'Onboarding is incomplete.');
  }
  const rules = personalizedOnboardingRules(data);
  await persistSelections(client, userID, data);

  const generated = await generateDailyPathForUser(client, {
    userID,
    mapDate,
    timeZoneIdentifier,
    rules,
    force: true,
    currentDayTimeSeconds,
    predictionRuntimeMode,
  });
  const dayMap = await ensureDayMap(client, { userID, mapDate, timeZoneIdentifier });
  const snapshot = await loadSnapshot(client, dayMap);
  const dayPlanState = await loadAuthoritativeDayPlanState(client, { dayMap, nowSecond: currentDayTimeSeconds });

  await client.query(
    `UPDATE user_game_profiles SET onboarding_status='completed',onboarding_version=$2,
      player_style=$3,difficulty=$4,target_pace_lb_per_week=$5,
      preferred_intervention_intensity=$4,onboarding_completed_at=NOW(),updated_at=NOW()
      WHERE user_id=$1`,
    [userID, ONBOARDING_VERSION, data.playerStyle, data.difficulty, PACE[data.difficulty] ?? 1.0],
  );
  await client.query(
    `UPDATE onboarding_sessions SET status='completed',current_stage='route_preview',
      first_route_map_date=$3,completed_at=NOW(),updated_at=NOW()
      WHERE user_id=$1 AND onboarding_version=$2`,
    [userID, ONBOARDING_VERSION, mapDate],
  );
  await awardOnboardingXP(client, userID);

  return {
    state: await loadOnboardingState(client, userID),
    completion: {
      schema: 'fifoo.onboarding-completed.v1',
      firstRouteMapDate: mapDate,
      xpAwarded: 50,
      message: 'Your first route is ready.',
    },
    generated,
    snapshot,
    dayPlanState,
  };
}
