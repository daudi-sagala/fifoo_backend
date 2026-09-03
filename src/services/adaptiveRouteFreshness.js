import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { buildAdaptiveRerouteCandidates, evaluateAdaptiveRouteFreshness } from '../algorithms/adaptiveRouteFreshness.js';
import { bumpRevision } from './dayMaps.js';
import { loadProgressSnapshot, rerouteFutureDayPlan } from './dayPlanning.js';

async function activePlan(client, dayMapID) {
  const result = await client.query(
    `SELECT plan_id,plan_revision,graph_data,routing_context,algorithm_name,
            algorithm_version,rules_hash,reroute_reason,decision_second,activated_at
       FROM day_plan_versions
      WHERE day_map_id=$1 AND plan_status='active'
      ORDER BY plan_revision DESC
      LIMIT 1
      FOR UPDATE`,
    [dayMapID],
  );
  return result.rows[0] ?? null;
}

async function latestLedgerEntries(client, planID) {
  const result = await client.query(
    `SELECT DISTINCT ON (l.plan_interval_id)
       i.algorithm_interval_id AS interval_id,
       l.outcome_status AS status,
       l.observed_at
     FROM progress_ledger_entries l
     JOIN day_plan_intervals i ON i.plan_interval_id=l.plan_interval_id
    WHERE l.plan_id=$1
    ORDER BY l.plan_interval_id,l.recorded_at DESC,l.ledger_entry_id DESC`,
    [planID],
  );
  return result.rows.map((row) => ({
    intervalID: row.interval_id,
    status: row.status,
    observedAt: row.observed_at,
  }));
}

/**
 * One user's transactional freshness check. It obtains a per-user/day advisory
 * lock, performs a no-op when the current plan is healthy, and bumps the normal
 * Day Map revision only when it actually publishes a new authoritative plan.
 */
export async function refreshAdaptiveRouteForUser({
  userID,
  mapDate,
  timeZoneIdentifier,
  nowSecond,
  now = new Date(),
} = {}) {
  return withTransaction(async (client) => {
    const lock = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS locked',
      [`fifoo-adaptive-route-freshness:${userID}:${mapDate}`],
    );
    if (!lock.rows[0]?.locked) return { rerouted: false, reason: 'locked_by_another_instance', mapDate };

    const dayMapResult = await client.query(
      `SELECT day_map_id,user_id,map_date::text,timezone,revision,current_progress,current_time_seconds
         FROM day_maps
        WHERE user_id=$1 AND map_date=$2::date
        LIMIT 1
        FOR UPDATE`,
      [userID, mapDate],
    );
    if (!dayMapResult.rowCount) return { rerouted: false, reason: 'no_day_map', mapDate };
    const dayMap = dayMapResult.rows[0];

    const boundary = Math.max(1, Math.min(DAY_END_SECOND - 1, clampSecond(nowSecond)));
    if (DAY_END_SECOND - boundary < config.adaptiveRouteFreshnessMinimumRemainingSeconds) {
      return { rerouted: false, reason: 'day_almost_over', mapDate, decisionSecond: boundary };
    }

    const active = await activePlan(client, dayMap.day_map_id);
    if (!active?.graph_data?.chosenPath?.intervals) {
      return { rerouted: false, reason: 'no_active_day_plan', mapDate, decisionSecond: boundary };
    }

    const activatedAt = active.activated_at ? new Date(active.activated_at).getTime() : 0;
    const planAgeMs = Math.max(0, now.getTime() - activatedAt);
    if (activatedAt && planAgeMs < config.adaptiveRouteFreshnessCooldownMs) {
      return {
        rerouted: false,
        reason: 'cooldown',
        mapDate,
        decisionSecond: boundary,
        retryAfterMs: config.adaptiveRouteFreshnessCooldownMs - planAgeMs,
      };
    }

    const [ledgerEntries, progressSnapshot] = await Promise.all([
      latestLedgerEntries(client, active.plan_id),
      loadProgressSnapshot(client, { dayMapID: dayMap.day_map_id, nowSecond: boundary }),
    ]);

    const evaluation = evaluateAdaptiveRouteFreshness({
      dayPlan: active.graph_data,
      ledgerEntries,
      progressSnapshot,
      nowSecond: boundary,
      missedGraceSeconds: config.adaptiveRouteFreshnessMissedGraceSeconds,
      atRiskWindowSeconds: config.adaptiveRouteFreshnessAtRiskWindowSeconds,
      minimumExpectedDayFinish: config.adaptiveRouteFreshnessMinimumExpectedDayFinish,
      minimumProjectionCandidateCount: config.adaptiveRouteFreshnessMinimumProjectionCandidateCount,
      previousFingerprint: active.routing_context?.freshnessFingerprint ?? null,
    });
    if (!evaluation.shouldReroute) {
      return {
        rerouted: false,
        reason: evaluation.reason,
        mapDate,
        decisionSecond: boundary,
        progressSnapshot,
      };
    }

    const candidates = buildAdaptiveRerouteCandidates({
      dayPlan: active.graph_data,
      decisionSecond: boundary,
      trigger: evaluation,
      maxShiftSeconds: config.adaptiveRouteFreshnessMaxShiftSeconds,
      rebaseBufferSeconds: config.adaptiveRouteFreshnessRebaseBufferSeconds,
    });
    if (!candidates.length) {
      return {
        rerouted: false,
        reason: 'no_future_candidates',
        mapDate,
        decisionSecond: boundary,
        evaluation,
      };
    }

    await client.query('SAVEPOINT adaptive_route_freshness_reroute');
    try {
      const result = await rerouteFutureDayPlan(client, {
        dayMap,
        userID,
        mapDate,
        decisionSecond: boundary,
        candidates,
        rerouteReason: 'adaptive_route_freshness',
        routingContext: {
          ...(active.routing_context ?? {}),
          mode: 'adaptive-route-freshness',
          timeZoneIdentifier,
          defaultTransitionSeconds: 0,
          freshnessTrigger: evaluation.trigger,
          freshnessFingerprint: evaluation.fingerprint,
          freshnessDetails: evaluation.details ?? {},
        },
        algorithmName: active.algorithm_name ?? 'fifoo-deterministic-router',
        algorithmVersion: Number(active.algorithm_version ?? 2),
        rulesHash: active.rules_hash ?? null,
        alternativeCount: 2,
        timeZoneIdentifier,
        predictionRuntimeMode: config.predictionRuntimeMode,
        occurredAt: now.toISOString(),
      });
      const revision = await bumpRevision(client, dayMap.day_map_id);
      await client.query('RELEASE SAVEPOINT adaptive_route_freshness_reroute');
      return {
        rerouted: true,
        reason: evaluation.trigger,
        mapDate,
        decisionSecond: boundary,
        revision,
        evaluation,
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
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT adaptive_route_freshness_reroute');
      await client.query('RELEASE SAVEPOINT adaptive_route_freshness_reroute');
      return {
        rerouted: false,
        reason: `reroute_failed:${error.message}`,
        mapDate,
        decisionSecond: boundary,
        evaluation,
      };
    }
  });
}
