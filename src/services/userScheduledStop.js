import {
  activityContent,
  activityEndTimeSeconds,
  gameNodeID,
  nodeTimeSeconds,
} from '../lib/nodeCodec.js';

const TERMINAL_LIFECYCLE = new Set([
  'completed',
  'skipped',
  'superseded',
  'cancelledByConstraint',
]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampSecond(value, { allowEnd = false } = {}) {
  const maximum = allowEnd ? 86_400 : 86_399;
  return Math.max(0, Math.min(maximum, Math.trunc(finite(value, 0))));
}

function candidateKind(node) {
  const activity = activityContent(node);
  const type = String(activity?.activityType ?? '').trim().toLowerCase();
  if (type === 'meal' || type === 'workout' || type === 'task') return type;

  // Posts/tips/requests may still be deliberately placed on the schedule.
  // Day Graph v4 has no post interval kind, so represent their scheduling
  // footprint as a task while retaining the persisted source node ID.
  return 'task';
}

function defaultDurationSeconds(node, kind) {
  const activity = activityContent(node);
  const workoutDuration = Number(activity?.workout?.durationInSeconds);
  if (kind === 'workout' && Number.isFinite(workoutDuration) && workoutDuration > 0) {
    return Math.max(60, Math.trunc(workoutDuration));
  }

  if (kind === 'meal') return 30 * 60;
  if (kind === 'workout') return 45 * 60;
  if (kind === 'task') return 30 * 60;
  return 15 * 60;
}

function nodeDurationSeconds(node, startSecond, kind) {
  const activity = activityContent(node);
  const endClock = activityEndTimeSeconds(activity);
  if (Number.isFinite(endClock) && endClock > startSecond) {
    return Math.max(60, Math.trunc(endClock - startSecond));
  }
  return defaultDurationSeconds(node, kind);
}

function progressDefaults(kind) {
  switch (kind) {
    case 'meal':
      return { category: 'nutrition', weight: 8, goalImpact: 0.55 };
    case 'workout':
      return { category: 'exercise', weight: 10, goalImpact: 0.70 };
    default:
      return { category: 'habits', weight: 4, goalImpact: 0.35 };
  }
}

export function candidateFromUserAddedNode(node, decisionSecond = 0) {
  const sourceNodeID = gameNodeID(node);
  if (!sourceNodeID) return null;

  const startSecond = clampSecond(nodeTimeSeconds(node));
  if (startSecond < clampSecond(decisionSecond)) return null;

  const kind = candidateKind(node);
  const durationSeconds = Math.min(
    Math.max(1, 86_400 - startSecond),
    nodeDurationSeconds(node, startSecond, kind),
  );
  const defaults = progressDefaults(kind);
  const key = `user-scheduled:${sourceNodeID}`;

  return {
    key,
    candidateKey: key,
    decisionGroup: key,
    kind,
    sourceNodeID,
    required: true,
    fixedStartSecond: startSecond,
    earliestStartSecond: startSecond,
    latestEndSecond: Math.min(86_400, startSecond + durationSeconds),
    durationSeconds,
    progressCategory: defaults.category,
    progressWeightHint: defaults.weight,
    goalImpact: defaults.goalImpact,
    priority: 0.85,
    urgency: 0.70,
    preferenceFit: 1,
    contextFit: 0.85,
    momentumFit: 0.5,
    effortCost: kind === 'workout' ? 0.5 : 0.15,
    fatigueCost: kind === 'workout' ? 0.4 : 0.05,
    completionProbability: 0.80,
    completionEvaluator: kind === 'workout'
      ? { type: 'duration', plannedSeconds: durationSeconds }
      : { type: 'binary' },
    metadata: {
      userScheduled: true,
      title: activityContent(node)?.title ?? '',
    },
  };
}

export function futureCandidatesFromDayPlan(dayPlan, decisionSecond = 0) {
  const decision = clampSecond(decisionSecond);
  const intervals = dayPlan?.chosenPath?.intervals ?? [];
  const seen = new Set();
  const result = [];

  for (const interval of intervals) {
    const sourceNodeID = interval?.sourceNodeID;
    if (!sourceNodeID || seen.has(String(sourceNodeID))) continue;
    if (finite(interval.endSecond) <= decision) continue;
    if (TERMINAL_LIFECYCLE.has(String(interval.lifecycleStatus ?? ''))) continue;

    seen.add(String(sourceNodeID));
    const durationSeconds = Math.max(1, finite(interval.endSecond) - finite(interval.startSecond));
    const potential = Math.max(0, finite(interval.potentialPoints ?? interval.progressWeightHint, 1));

    result.push({
      key: String(interval.key ?? interval.candidateKey ?? sourceNodeID),
      candidateKey: String(interval.candidateKey ?? interval.key ?? sourceNodeID),
      decisionGroup: String(interval.candidateKey ?? interval.key ?? sourceNodeID),
      kind: String(interval.intervalKind ?? 'task'),
      sourceNodeID,
      required: true,
      fixedStartSecond: null,
      earliestStartSecond: Math.max(decision, clampSecond(interval.startSecond)),
      latestEndSecond: 86_400,
      durationSeconds,
      progressCategory: String(interval.progressCategory ?? 'habits'),
      progressWeightHint: Math.max(0.0001, potential),
      goalImpact: Math.min(1, potential / 100),
      priority: 0.5,
      urgency: 0.5,
      preferenceFit: 0.5,
      contextFit: 0.5,
      momentumFit: 0.5,
      hardExcluded: false,
    });
  }

  return result;
}

export function candidatesIncludingUserAddedNode({
  dayPlan,
  node,
  decisionSecond = 0,
} = {}) {
  const added = candidateFromUserAddedNode(node, decisionSecond);
  if (!added) return futureCandidatesFromDayPlan(dayPlan, decisionSecond);

  const existing = futureCandidatesFromDayPlan(dayPlan, decisionSecond)
    .filter((candidate) => String(candidate.sourceNodeID) !== String(added.sourceNodeID));
  return [...existing, added];
}
