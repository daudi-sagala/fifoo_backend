const DAY_END_SECOND = 86_400;
const TERMINAL_STATUSES = new Set([
  'completed',
  'skipped',
  'partiallyCompleted',
  'superseded',
]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampSecond(value, { allowEnd = false } = {}) {
  const maximum = allowEnd ? DAY_END_SECOND : DAY_END_SECOND - 1;
  return Math.max(0, Math.min(maximum, Math.trunc(finite(value, 0))));
}

function candidateKey(interval) {
  return String(interval?.candidateKey ?? interval?.key ?? interval?.intervalID ?? 'candidate');
}

function decisionGroup(interval) {
  return String(interval?.metadata?.decisionGroup ?? candidateKey(interval));
}

function intervalProbability(interval) {
  const value = Number(interval?.metadata?.completionProbability);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
}

function latestLedgerByInterval(ledgerEntries = []) {
  const result = new Map();
  for (const entry of ledgerEntries) {
    const key = String(entry.intervalID ?? entry.interval_id ?? '');
    if (!key) continue;
    const previous = result.get(key);
    const observedAt = String(entry.observedAt ?? entry.observed_at ?? '');
    const previousObservedAt = String(previous?.observedAt ?? previous?.observed_at ?? '');
    if (!previous || observedAt >= previousObservedAt) result.set(key, entry);
  }
  return result;
}

function isTerminal(entry) {
  if (!entry) return false;
  return TERMINAL_STATUSES.has(String(entry.status ?? entry.outcome_status ?? ''));
}

function activityIntervals(dayPlan) {
  return (dayPlan?.chosenPath?.intervals ?? [])
    .filter((interval) => interval?.sourceNodeID)
    .sort((a, b) => finite(a.startSecond) - finite(b.startSecond));
}

function triggerFingerprint(trigger, intervals = []) {
  const identities = intervals
    .map((interval) => `${candidateKey(interval)}@${finite(interval.startSecond)}-${finite(interval.endSecond)}`)
    .sort()
    .join('|');
  return `${trigger}:${identities}`;
}

/**
 * Pure freshness evaluator. It deliberately ignores system-generated sleep,
 * nap, fasting and other filler intervals because those are planner coverage,
 * not evidence that the user's route is stale.
 */
export function evaluateAdaptiveRouteFreshness({
  dayPlan,
  ledgerEntries = [],
  progressSnapshot = null,
  nowSecond,
  missedGraceSeconds = 300,
  atRiskWindowSeconds = 600,
  minimumExpectedDayFinish = 0.60,
  minimumProjectionCandidateCount = 2,
  previousFingerprint = null,
} = {}) {
  const decisionSecond = clampSecond(nowSecond);
  const ledger = latestLedgerByInterval(ledgerEntries);
  const activities = activityIntervals(dayPlan);
  if (!activities.length) {
    return { shouldReroute: false, reason: 'no_activity_intervals', decisionSecond };
  }

  const unresolved = activities.filter((interval) => {
    const entry = ledger.get(String(interval.intervalID));
    return !isTerminal(entry);
  });

  const missed = unresolved.filter((interval) => (
    finite(interval.endSecond) + Math.max(0, finite(missedGraceSeconds)) <= decisionSecond
  ));
  if (missed.length) {
    const fingerprint = triggerFingerprint('activity_window_missed', missed);
    if (fingerprint !== previousFingerprint) {
      return {
        shouldReroute: true,
        trigger: 'activity_window_missed',
        fingerprint,
        decisionSecond,
        intervalID: String(missed.at(-1)?.intervalID ?? ''),
        sourceNodeID: String(missed.at(-1)?.sourceNodeID ?? ''),
        affectedIntervalCount: missed.length,
        details: {
          missedCandidateKeys: missed.map(candidateKey),
          latestMissedEndSecond: Math.max(...missed.map((interval) => finite(interval.endSecond))),
        },
      };
    }
  }

  const atRisk = unresolved
    .filter((interval) => {
      const start = finite(interval.startSecond);
      const end = finite(interval.endSecond);
      const remaining = end - decisionSecond;
      return start < decisionSecond
        && end > decisionSecond
        && remaining <= Math.max(60, finite(atRiskWindowSeconds));
    })
    .sort((a, b) => finite(a.endSecond) - finite(b.endSecond));
  if (atRisk.length) {
    const interval = atRisk[0];
    const fingerprint = triggerFingerprint('activity_window_at_risk', [interval]);
    if (fingerprint !== previousFingerprint) {
      return {
        shouldReroute: true,
        trigger: 'activity_window_at_risk',
        fingerprint,
        decisionSecond,
        intervalID: String(interval.intervalID ?? ''),
        sourceNodeID: String(interval.sourceNodeID ?? ''),
        affectedIntervalCount: 1,
        details: {
          candidateKey: candidateKey(interval),
          originalStartSecond: finite(interval.startSecond),
          originalEndSecond: finite(interval.endSecond),
          secondsRemaining: Math.max(0, finite(interval.endSecond) - decisionSecond),
        },
      };
    }
  }

  const futureActivities = unresolved.filter((interval) => finite(interval.endSecond) > decisionSecond);
  const expectedDayFinish = Number(progressSnapshot?.expectedDayFinish);
  if (futureActivities.length >= Math.max(1, Math.trunc(finite(minimumProjectionCandidateCount, 2)))
      && Number.isFinite(expectedDayFinish)
      && expectedDayFinish < Math.max(0, Math.min(1, finite(minimumExpectedDayFinish, 0.60)))) {
    const projectionBucket = Math.round(expectedDayFinish * 20) / 20; // 5-point materiality bucket.
    const fingerprint = `${triggerFingerprint('expected_finish_degraded', futureActivities)}:${projectionBucket.toFixed(2)}`;
    if (fingerprint !== previousFingerprint) {
      const probabilities = futureActivities
        .map(intervalProbability)
        .filter((value) => value != null);
      return {
        shouldReroute: true,
        trigger: 'expected_finish_degraded',
        fingerprint,
        decisionSecond,
        intervalID: null,
        sourceNodeID: null,
        affectedIntervalCount: futureActivities.length,
        details: {
          expectedDayFinish,
          expectedFinishPoints: Number(progressSnapshot?.expectedFinishPoints ?? 0),
          meanFutureCompletionProbability: probabilities.length
            ? probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length
            : null,
        },
      };
    }
  }

  return {
    shouldReroute: false,
    reason: previousFingerprint ? 'fresh_or_duplicate_trigger' : 'fresh',
    decisionSecond,
  };
}

function pathCandidates(dayPlan) {
  const chosen = dayPlan?.chosenPath?.intervals ?? [];
  const alternatives = (dayPlan?.alternativeBranches ?? [])
    .flatMap((path) => path?.intervals ?? []);
  return { chosen, all: [...chosen, ...alternatives] };
}

/**
 * Reconstructs the smallest safe candidate pool from the active Day Graph.
 * Future scheduled activities retain their exact times. The one currently
 * expiring activity may become movable so Fifoo can salvage it after `now`.
 * System filler intervals are never submitted as candidates; the Day Graph
 * compiler regenerates Sleep/Nap/Fasting coverage around the new route.
 */
export function buildAdaptiveRerouteCandidates({
  dayPlan,
  decisionSecond,
  trigger,
  maxShiftSeconds = 7_200,
  rebaseBufferSeconds = 60,
} = {}) {
  const boundary = Math.max(1, Math.min(DAY_END_SECOND - 1, clampSecond(decisionSecond)));
  const { chosen, all } = pathCandidates(dayPlan);
  const chosenGroups = new Set(
    chosen
      .filter((interval) => interval?.sourceNodeID && finite(interval.endSecond) > boundary)
      .map(decisionGroup),
  );
  const seen = new Set();
  const candidates = [];

  for (const interval of all) {
    if (!interval?.sourceNodeID) continue;
    const endSecond = finite(interval.endSecond);
    const startSecond = finite(interval.startSecond);
    if (endSecond <= boundary) continue;

    const key = candidateKey(interval);
    const group = decisionGroup(interval);
    const dedupeKey = `${key}:${interval.sourceNodeID}`;
    if (seen.has(dedupeKey)) continue;

    const durationSeconds = Math.max(1, endSecond - startSecond);
    let fixedStartSecond = startSecond;
    let earliestStartSecond = startSecond;
    let latestEndSecond = endSecond;
    let rebasedByFreshness = false;

    if (startSecond < boundary) {
      const isTriggeredInterval = String(interval.intervalID ?? '') === String(trigger?.intervalID ?? '')
        || (trigger?.sourceNodeID && String(interval.sourceNodeID) === String(trigger.sourceNodeID));
      if (!isTriggeredInterval || trigger?.trigger !== 'activity_window_at_risk') continue;

      fixedStartSecond = null;
      earliestStartSecond = Math.min(DAY_END_SECOND - 1, boundary + Math.max(0, finite(rebaseBufferSeconds, 60)));
      latestEndSecond = Math.min(
        DAY_END_SECOND,
        Math.max(
          earliestStartSecond + durationSeconds,
          endSecond + Math.max(0, finite(maxShiftSeconds, 7_200)),
        ),
      );
      if (earliestStartSecond + durationSeconds > latestEndSecond) continue;
      rebasedByFreshness = true;
    }

    seen.add(dedupeKey);
    candidates.push({
      key,
      candidateKey: key,
      decisionGroup: group,
      kind: interval.intervalKind ?? 'task',
      intervalKind: interval.intervalKind ?? 'task',
      sourceNodeID: interval.sourceNodeID,
      required: chosenGroups.has(group),
      fixedStartSecond,
      earliestStartSecond,
      latestEndSecond,
      durationSeconds,
      progressCategory: interval.progressCategory ?? 'routine',
      progressWeightHint: Math.max(0.0001, finite(interval.progressWeightHint ?? interval.potentialPoints, 1)),
      completionProbability: intervalProbability(interval) ?? 0.65,
      completionEvaluator: interval.completionEvaluator ?? { type: 'binary' },
      metabolicContext: interval.metabolicContext ?? null,
      metadata: {
        ...(interval.metadata ?? {}),
        adaptiveRouteFreshness: true,
        rebasedByFreshness,
        originalStartSecond: startSecond,
        originalEndSecond: endSecond,
      },
    });
  }

  return candidates.sort((a, b) => (
    finite(a.earliestStartSecond) - finite(b.earliestStartSecond)
      || String(a.key).localeCompare(String(b.key))
  ));
}

