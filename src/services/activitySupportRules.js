import { activityContent, nodeTimeSeconds } from '../lib/nodeCodec.js';
import { stableUUID } from '../lib/stableUUID.js';

export const SUPPORT_PLANNER_SCHEMA = 'fifoo.activity-support.v1';
export const SUPPORT_GENERATOR_VERSION = 1;
export const SUPPORT_SLOT_STEP_SECONDS = 15 * 60;

function clampSecond(value, upper = 86_400) {
  return Math.max(0, Math.min(upper, Math.trunc(Number(value) || 0)));
}

export function addLocalDays(mapDate, days) {
  const match = String(mapDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new TypeError(`Invalid map date: ${mapDate}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

export function localDayDifference(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00.000Z`).getTime();
  const to = new Date(`${toDate}T00:00:00.000Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

export function displayClock(secondsValue) {
  const seconds = Math.max(0, Math.min(86_399, Math.trunc(Number(secondsValue) || 0)));
  const hour24 = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  const period = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = (hour24 % 12) || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function normalizedText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function looksHomeCooked(activity) {
  const source = normalizedText(activity?.meal?.executionPlan?.source).replace(/[\s_-]/g, '');
  if (['homemade', 'homecooked', 'cookathome'].includes(source)) return { matched: true, explicit: true };

  const text = [activity?.title, activity?.description, activity?.meal?.title]
    .map(normalizedText)
    .join(' ');
  const matched = /\b(home[- ]?made|home[- ]?cooked|cook(?:ed|ing)? at home)\b/.test(text);
  return { matched, explicit: false };
}

/**
 * MVP rule registry. It intentionally begins narrow: explicit or clearly named
 * home-made meals. The returned objects are semantic requirements, not route
 * edges; the planner later realizes them as ordinary task GameNodes.
 */
export function supportRequirementsForNode(node) {
  const activity = activityContent(node);
  if (!activity || normalizedText(activity.activityType) !== 'meal') return [];

  const homeCooked = looksHomeCooked(activity);
  if (!homeCooked.matched) return [];

  const executionPlan = activity.meal?.executionPlan ?? null;
  const shoppingList = Array.isArray(executionPlan?.shoppingList)
    ? executionPlan.shoppingList.filter((entry) => String(entry ?? '').trim())
    : [];
  const groceriesExplicitlyNeeded = executionPlan?.groceriesNeeded === true || shoppingList.length > 0;
  const ingredientsReady = executionPlan?.ingredientsReady === true;
  const title = String(activity.title ?? activity.meal?.title ?? 'meal').trim() || 'meal';

  const requirements = [];
  if (groceriesExplicitlyNeeded || (!homeCooked.explicit && !ingredientsReady)) {
    requirements.push({
      ruleKey: 'meal.home-made.groceries.v1',
      relationshipType: 'resource_for',
      actionKind: 'groceries',
      title: `Get groceries for ${title}`,
      durationSeconds: 45 * 60,
      preferredStartSecond: 18 * 3600 + 30 * 60,
      latestPreviousDayEndSecond: 21 * 3600 + 30 * 60,
      sameDayLeadSeconds: 2 * 3600,
      maxAdvanceDays: 2,
      confidence: groceriesExplicitlyNeeded ? 0.95 : 0.72,
      reason: `Ingredients should be available before ${title}.`,
      targetTitle: title,
    });
  }

  // Home cooking nearly always benefits from a small preparation block. We do
  // not create it after the meal has already started; the planner filters that.
  requirements.push({
    ruleKey: 'meal.home-made.prep.v1',
    relationshipType: 'prepares_for',
    actionKind: 'meal_prep',
    title: `Prep for ${title}`,
    durationSeconds: 20 * 60,
    preferredStartSecond: 20 * 3600,
    latestPreviousDayEndSecond: 22 * 3600,
    sameDayLeadSeconds: 30 * 60,
    maxAdvanceDays: 1,
    confidence: homeCooked.explicit ? 0.88 : 0.70,
    reason: `A short prep block reduces friction before ${title}.`,
    targetTitle: title,
  });

  return requirements;
}

function overlaps(start, end, interval) {
  return start < interval.endSecond && interval.startSecond < end;
}

function alignedFloor(value, step) {
  return Math.floor(value / step) * step;
}

/** Pick the closest available 15-minute slot to preferredStartSecond. */
export function findSupportSlot({
  existingIntervals = [],
  earliestStartSecond = 0,
  latestEndSecond = 86_400,
  durationSeconds,
  preferredStartSecond = earliestStartSecond,
  stepSeconds = SUPPORT_SLOT_STEP_SECONDS,
} = {}) {
  const duration = Math.max(60, Math.trunc(Number(durationSeconds) || 0));
  const earliest = clampSecond(earliestStartSecond);
  const latest = clampSecond(latestEndSecond);
  if (latest - earliest < duration) return null;

  const normalizedIntervals = (existingIntervals ?? [])
    .map((entry) => ({
      startSecond: clampSecond(entry.startSecond),
      endSecond: clampSecond(entry.endSecond),
    }))
    .filter((entry) => entry.endSecond > entry.startSecond)
    .sort((a, b) => a.startSecond - b.startSecond);

  const minStart = Math.ceil(earliest / stepSeconds) * stepSeconds;
  const maxStart = alignedFloor(latest - duration, stepSeconds);
  const preferred = Math.max(minStart, Math.min(maxStart, alignedFloor(preferredStartSecond, stepSeconds)));
  const candidates = [];
  for (let start = minStart; start <= maxStart; start += stepSeconds) candidates.push(start);
  candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);

  for (const startSecond of candidates) {
    const endSecond = startSecond + duration;
    if (!normalizedIntervals.some((interval) => overlaps(startSecond, endSecond, interval))) {
      return { startSecond, endSecond };
    }
  }
  return null;
}

function coordinatePlacement(secondsFromMidnight, progressPercent = 0) {
  return {
    coordinate: {
      _0: {
        time: { secondsFromMidnight },
        progress: { percent: progressPercent },
      },
    },
  };
}

export function buildSupportTaskNode({
  userID,
  supportMapDate,
  slot,
  targetNodeID,
  targetMapDate,
  targetStartSecond,
  requirement,
} = {}) {
  const seed = `activity-support:v${SUPPORT_GENERATOR_VERSION}:${userID}:${targetNodeID}:${requirement.ruleKey}`;
  const nodeID = stableUUID(`${seed}:node`);
  const activityID = stableUUID(`${seed}:activity`);
  const taskID = stableUUID(`${seed}:task`);
  const activityTaskID = stableUUID(`${seed}:activity-task`);
  const supportPlan = {
    schema: SUPPORT_PLANNER_SCHEMA,
    targetNodeID,
    targetMapDate,
    targetStartSecond,
    ruleKey: requirement.ruleKey,
    relationshipType: requirement.relationshipType,
    confidence: requirement.confidence,
    reason: requirement.reason,
    isGenerated: true,
    generatorVersion: SUPPORT_GENERATOR_VERSION,
  };

  return {
    id: { rawValue: nodeID },
    placement: coordinatePlacement(slot.startSecond, 0),
    time: { secondsFromMidnight: slot.startSecond },
    content: {
      activity: {
        _0: {
          activityID,
          title: requirement.title,
          date: supportMapDate,
          startTime: displayClock(slot.startSecond),
          endTime: displayClock(Math.min(86_399, slot.endSecond)),
          location: '',
          description: `${requirement.reason} Added automatically by Fifoo for ${requirement.targetTitle} on ${targetMapDate}.`,
          activityType: 'task',
          status: 'Not Started',
          task: {
            activityTaskID,
            taskID,
            title: requirement.title,
            description: requirement.reason,
            imageURLs: null,
            videoURLs: null,
          },
          supportPlan,
        },
      },
    },
    isEnabled: true,
  };
}

export function targetSecondsFromNow({ anchorMapDate, nowSecond, targetMapDate, targetNode }) {
  const targetSecond = nodeTimeSeconds(targetNode);
  const days = localDayDifference(anchorMapDate, targetMapDate);
  return (days * 86_400) + targetSecond - Number(nowSecond ?? 0);
}
