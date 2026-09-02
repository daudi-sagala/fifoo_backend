import { createHmac } from 'node:crypto';

export const LEARNING_FEATURE_SCHEMA_VERSION = 1;
export const LEARNING_POLICY_VERSION = 'phase4-v1';

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid timestamp is required.');
  return date.toISOString();
}

function safeArray(value, mapper = (entry) => entry) {
  return Array.isArray(value) ? value.map(mapper) : [];
}

function safeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const startSecond = numberOrNull(window.startSecond);
  const endSecond = numberOrNull(window.endSecond);
  if (startSecond == null || endSecond == null || endSecond <= startSecond) return null;
  return { startSecond, endSecond };
}

/**
 * Data minimization boundary for learning context. Free-form titles, notes,
 * messages, addresses and other user text are intentionally not copied into the
 * training foundation.
 */
export function sanitizeLearningContext(context = {}) {
  const availabilityWindows = safeArray(context.availabilityWindows, safeWindow).filter(Boolean);
  const hardBusyIntervals = safeArray(context.hardBusyIntervals, safeWindow).filter(Boolean);
  const result = {
    mode: context.mode == null ? null : String(context.mode),
    timeZoneIdentifier: context.timeZoneIdentifier == null ? null : String(context.timeZoneIdentifier),
    defaultTransitionSeconds: numberOrNull(context.defaultTransitionSeconds),
    wakeSecond: numberOrNull(context.wakeSecond),
    sleepSecond: numberOrNull(context.sleepSecond),
    availabilityWindows,
    hardBusyIntervals,
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value != null));
}

export function sanitizeCandidateFeatures(candidate = {}) {
  const featureNames = [
    'durationSeconds',
    'earliestStartSecond',
    'latestEndSecond',
    'fixedStartSecond',
    'progressWeightHint',
    'normalizedProgressValue',
    'goalImpact',
    'priority',
    'urgency',
    'preferenceFit',
    'contextFit',
    'momentumFit',
    'effortCost',
    'fatigueCost',
    'transitionCost',
    'completionProbability',
  ];
  const numeric = Object.fromEntries(
    featureNames
      .map((key) => [key, numberOrNull(candidate[key])])
      .filter(([, value]) => value != null),
  );
  return {
    ...numeric,
    required: candidate.required === true,
    hardExcluded: candidate.hardExcluded === true,
    dependencyCount: Array.isArray(candidate.dependencies) ? candidate.dependencies.length : 0,
    availabilityWindowCount: Array.isArray(candidate.availabilityWindows) ? candidate.availabilityWindows.length : 0,
    progressCategory: candidate.progressCategory == null ? null : String(candidate.progressCategory),
  };
}

export function normalizeCandidateObservation(candidate = {}, index = 0) {
  const key = String(candidate.candidateKey ?? candidate.key ?? `candidate-${index}`);
  const selected = candidate.wasSelected === true || candidate.selectedByChosenRoute === true;
  const completionProbability = numberOrNull(
    candidate.predictedCompletionProbability ?? candidate.completionProbability,
  );
  const progressWeight = numberOrNull(candidate.potentialPoints ?? candidate.progressWeightHint);
  return {
    candidateKey: key,
    decisionGroup: candidate.decisionGroup == null ? null : String(candidate.decisionGroup),
    candidateKind: candidate.kind == null
      ? (candidate.intervalKind == null ? null : String(candidate.intervalKind))
      : String(candidate.kind),
    sourceNodeID: candidate.sourceNodeID ?? null,
    candidateRank: Number.isInteger(candidate.candidateRank) ? candidate.candidateRank : index,
    wasEligible: candidate.wasEligible !== false && candidate.hardExcluded !== true,
    wasSelected: selected,
    exclusionReason: candidate.exclusionReason ?? (candidate.hardExcluded === true ? 'hard_excluded' : null),
    predictedCompletionProbability: completionProbability == null ? null : clamp(completionProbability),
    predictedProgressPoints: numberOrNull(candidate.predictedProgressPoints ?? progressWeight),
    candidateFeatures: sanitizeCandidateFeatures(candidate),
  };
}

export function routeObservation(path = {}, index = 0, { selected = false, routeKind = null } = {}) {
  const intervals = Array.isArray(path.intervals) ? path.intervals : [];
  const selectedCandidateKeys = Array.isArray(path.selectedCandidateKeys)
    ? path.selectedCandidateKeys.map(String)
    : [...new Set(intervals.filter((entry) => entry.sourceNodeID).map((entry) => String(entry.candidateKey ?? entry.key)))];
  return {
    routeKey: String(path.pathKey ?? `route-${index}`),
    routeKind: routeKind ?? (selected ? 'chosen' : 'alternative'),
    routeRank: index,
    wasSelected: selected,
    routeScore: numberOrNull(path.routeScore),
    expectedProgress: numberOrNull(path.expectedProgress),
    selectedCandidateKeys,
    routeFeatures: {
      intervalCount: intervals.length,
      activityIntervalCount: intervals.filter((entry) => entry.sourceNodeID).length,
      skippedDecisionGroups: safeArray(path.skippedDecisionGroups, String),
      startSecond: intervals.length ? numberOrNull(intervals[0].startSecond) : null,
      endSecond: intervals.length ? numberOrNull(intervals.at(-1).endSecond) : null,
    },
  };
}

function bucketForSecond(second) {
  const value = Math.max(0, Math.min(86_399, Number(second) || 0));
  if (value < 6 * 3600) return 'overnight';
  if (value < 12 * 3600) return 'morning';
  if (value < 17 * 3600) return 'afternoon';
  if (value < 22 * 3600) return 'evening';
  return 'lateNight';
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function aggregateRows(rows, cutoffMs = null) {
  const filtered = cutoffMs == null
    ? rows
    : rows.filter((row) => new Date(row.observed_at).getTime() >= cutoffMs);
  const sampleCount = filtered.length;
  const completionScores = filtered.map((row) => Number(row.completion_score ?? 0));
  const earned = filtered.reduce((sum, row) => sum + Number(row.earned_points ?? 0), 0);
  const potential = filtered.reduce((sum, row) => sum + Number(row.potential_points ?? 0), 0);
  const skipped = filtered.filter((row) => row.actual_status === 'skipped').length;
  const partial = filtered.filter((row) => row.actual_status === 'partiallyCompleted').length;
  const completed = filtered.filter((row) => row.actual_status === 'completed').length;
  return {
    sampleCount,
    completionRate: ratio(completed, sampleCount),
    skipRate: ratio(skipped, sampleCount),
    partialRate: ratio(partial, sampleCount),
    averageCompletionScore: sampleCount
      ? completionScores.reduce((sum, value) => sum + value, 0) / sampleCount
      : null,
    earnedPotentialRatio: ratio(earned, potential),
  };
}

/**
 * Builds only from outcomes strictly before `asOf`, preventing target leakage.
 */
export async function buildBehavioralFeatureSnapshot(client, {
  userID,
  asOf = new Date().toISOString(),
  limit = 500,
  includeAsOf = false,
} = {}) {
  const asOfISO = iso(asOf);
  const comparison = includeAsOf ? '<=' : '<';
  const result = await client.query(
    `SELECT interval_kind,scheduled_start_second,completion_score,actual_status,
            potential_points,earned_points,observed_at
       FROM learning_outcome_observations
      WHERE user_id=$1 AND observed_at ${comparison} $2::timestamptz
      ORDER BY observed_at DESC
      LIMIT $3`,
    [userID, asOfISO, Math.max(1, Math.min(5_000, Number(limit) || 500))],
  );
  const rows = result.rows ?? [];
  const asOfMs = new Date(asOfISO).getTime();
  const sevenDays = aggregateRows(rows, asOfMs - (7 * 24 * 3600 * 1000));
  const thirtyDays = aggregateRows(rows, asOfMs - (30 * 24 * 3600 * 1000));
  const allTime = aggregateRows(rows);

  const kindStats = {};
  const timeBucketStats = {};
  for (const row of rows) {
    const kind = String(row.interval_kind ?? 'other');
    (kindStats[kind] ??= []).push(row);
    const bucket = bucketForSecond(row.scheduled_start_second);
    (timeBucketStats[bucket] ??= []).push(row);
  }

  const featureData = {
    allTime,
    trailing7Days: sevenDays,
    trailing30Days: thirtyDays,
    byKind: Object.fromEntries(Object.entries(kindStats).map(([key, entries]) => [key, aggregateRows(entries)])),
    byTimeBucket: Object.fromEntries(Object.entries(timeBucketStats).map(([key, entries]) => [key, aggregateRows(entries)])),
  };
  return {
    asOf: asOfISO,
    featureSchemaVersion: LEARNING_FEATURE_SCHEMA_VERSION,
    sampleCount: allTime.sampleCount,
    sourceWindowStart: rows.length ? iso(rows.at(-1).observed_at) : null,
    sourceWindowEnd: rows.length ? iso(rows[0].observed_at) : null,
    featureData,
  };
}

async function insertCandidate(client, decisionEventID, candidate, index) {
  const observation = normalizeCandidateObservation(candidate, index);
  const inserted = await client.query(
    `INSERT INTO learning_decision_candidates(
       routing_decision_event_id,candidate_key,decision_group,candidate_kind,source_node_id,
       candidate_rank,was_eligible,was_selected,exclusion_reason,
       predicted_completion_probability,predicted_progress_points,candidate_features
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT(routing_decision_event_id,candidate_key) DO NOTHING
     RETURNING learning_decision_candidate_id`,
    [
      decisionEventID,
      observation.candidateKey,
      observation.decisionGroup,
      observation.candidateKind,
      observation.sourceNodeID,
      observation.candidateRank,
      observation.wasEligible,
      observation.wasSelected,
      observation.exclusionReason,
      observation.predictedCompletionProbability,
      observation.predictedProgressPoints,
      JSON.stringify(observation.candidateFeatures),
    ],
  );
  return inserted.rows?.[0]?.learning_decision_candidate_id ?? null;
}

async function insertRoute(client, decisionEventID, route, index) {
  const observation = route.routeKey ? route : routeObservation(route, index, { selected: index === 0 });
  await client.query(
    `INSERT INTO learning_decision_routes(
       routing_decision_event_id,route_key,route_kind,route_rank,was_selected,
       route_score,expected_progress,selected_candidate_keys,route_features
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb)
     ON CONFLICT(routing_decision_event_id,route_key) DO NOTHING`,
    [
      decisionEventID,
      observation.routeKey,
      observation.routeKind,
      observation.routeRank ?? index,
      observation.wasSelected === true,
      observation.routeScore ?? null,
      observation.expectedProgress ?? null,
      observation.selectedCandidateKeys ?? [],
      JSON.stringify(observation.routeFeatures ?? {}),
    ],
  );
}

/**
 * Records one immutable decision exposure. All feature values are point-in-time
 * and all candidate/route options are stored, not only the winner.
 */
export async function captureRoutingDecision(client, {
  planID,
  parentPlanID = null,
  planRevision = null,
  dayMap,
  userID,
  mapDate,
  timeZoneIdentifier = null,
  decisionType,
  decisionSecond = null,
  rerouteReason = null,
  algorithmName,
  algorithmVersion,
  rulesHash,
  predictionMode = 'cold-start',
  predictionModelName = 'completion-prior-blend',
  predictionModelVersion = 1,
  routingContext = {},
  progressSnapshot = null,
  requestID = null,
  occurredAt = new Date().toISOString(),
  candidates = [],
  routes = [],
} = {}) {
  const occurredAtISO = iso(occurredAt);
  const behavioral = await buildBehavioralFeatureSnapshot(client, {
    userID,
    asOf: occurredAtISO,
  });
  const safeContext = {
    ...sanitizeLearningContext({ ...routingContext, timeZoneIdentifier }),
    behavioralFeatures: behavioral.featureData,
  };
  const chosenRoute = routes.find((route) => route.wasSelected === true) ?? routes[0] ?? null;
  const inserted = await client.query(
    `INSERT INTO routing_decision_events(
       plan_id,parent_plan_id,day_map_id,user_id,map_date,time_zone_identifier,
       plan_revision,decision_type,decision_second,reroute_reason,algorithm_name,
       algorithm_version,rules_hash,prediction_mode,prediction_model_name,
       prediction_model_version,feature_schema_version,policy_version,request_id,
       selected_route_key,context_data,progress_snapshot,candidate_data,
       predicted_progress,route_score,was_selected,occurred_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21::jsonb,$22::jsonb,$23::jsonb,$24,$25,TRUE,$26
     )
     ON CONFLICT(request_id) WHERE request_id IS NOT NULL DO NOTHING
     RETURNING routing_decision_event_id`,
    [
      planID,
      parentPlanID,
      dayMap.day_map_id,
      userID,
      mapDate,
      timeZoneIdentifier,
      planRevision,
      decisionType,
      decisionSecond,
      rerouteReason,
      algorithmName,
      algorithmVersion,
      rulesHash,
      predictionMode,
      predictionModelName,
      predictionModelVersion,
      LEARNING_FEATURE_SCHEMA_VERSION,
      LEARNING_POLICY_VERSION,
      requestID,
      chosenRoute?.routeKey ?? null,
      JSON.stringify(safeContext),
      JSON.stringify(progressSnapshot ?? {}),
      JSON.stringify({ candidateCount: candidates.length, routeCount: routes.length }),
      chosenRoute?.expectedProgress ?? null,
      chosenRoute?.routeScore ?? null,
      occurredAtISO,
    ],
  );
  let decisionEventID = inserted.rows?.[0]?.routing_decision_event_id ?? null;
  if (!decisionEventID && requestID) {
    const existing = await client.query(
      `SELECT routing_decision_event_id FROM routing_decision_events WHERE request_id=$1`,
      [requestID],
    );
    decisionEventID = existing.rows?.[0]?.routing_decision_event_id ?? null;
  }
  if (!decisionEventID) throw new Error('Learning decision event could not be persisted.');

  for (let index = 0; index < candidates.length; index += 1) {
    await insertCandidate(client, decisionEventID, candidates[index], index);
  }
  for (let index = 0; index < routes.length; index += 1) {
    await insertRoute(client, decisionEventID, routes[index], index);
  }
  await client.query(
    `INSERT INTO learning_feature_snapshots(
       user_id,routing_decision_event_id,as_of,feature_schema_version,sample_count,
       source_window_start,source_window_end,feature_data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     ON CONFLICT(routing_decision_event_id) DO NOTHING`,
    [
      userID,
      decisionEventID,
      behavioral.asOf,
      behavioral.featureSchemaVersion,
      behavioral.sampleCount,
      behavioral.sourceWindowStart,
      behavioral.sourceWindowEnd,
      JSON.stringify(behavioral.featureData),
    ],
  );
  return { decisionEventID, behavioralFeatures: behavioral };
}

export async function refreshUserRoutingProfile(client, {
  userID,
  asOf = new Date().toISOString(),
} = {}) {
  const snapshot = await buildBehavioralFeatureSnapshot(client, {
    userID,
    asOf,
    includeAsOf: true,
  });
  await client.query(
    `INSERT INTO user_routing_profiles(
       user_id,profile_version,behavioral_features,individual_sample_count,updated_at
     ) VALUES ($1,1,$2::jsonb,$3,NOW())
     ON CONFLICT(user_id) DO UPDATE SET
       profile_version=user_routing_profiles.profile_version + 1,
       behavioral_features=EXCLUDED.behavioral_features,
       individual_sample_count=EXCLUDED.individual_sample_count,
       updated_at=NOW()`,
    [userID, JSON.stringify(snapshot.featureData), snapshot.sampleCount],
  );
  return snapshot;
}


/**
 * Mirrors an immutable progress-ledger entry into the learning outcome stream.
 * A corrected ledger entry creates another observation rather than rewriting
 * history, preserving labels as they were known over time.
 */
export async function captureLearningOutcome(client, {
  ledgerEntryID,
  supersedesLedgerEntryID = null,
  planID,
  planIntervalID,
  userID,
  sourceNodeID = null,
  candidateKey = null,
  intervalKind,
  startSecond,
  endSecond,
  status,
  completionScore,
  potentialPoints,
  earnedPoints,
  reasonCode = null,
  evidence = {},
  observedAt,
} = {}) {
  const decision = await client.query(
    `SELECT routing_decision_event_id
       FROM routing_decision_events
      WHERE plan_id=$1
      ORDER BY occurred_at DESC,routing_decision_event_id DESC
      LIMIT 1`,
    [planID],
  );
  const decisionEventID = decision.rows?.[0]?.routing_decision_event_id ?? null;

  let candidateID = null;
  if (decisionEventID) {
    const candidate = await client.query(
      `SELECT learning_decision_candidate_id
         FROM learning_decision_candidates
        WHERE routing_decision_event_id=$1
          AND (
            ($2::uuid IS NOT NULL AND source_node_id=$2::uuid)
            OR ($3::text IS NOT NULL AND candidate_key=$3::text)
          )
        ORDER BY was_selected DESC,candidate_rank ASC
        LIMIT 1`,
      [decisionEventID, sourceNodeID, candidateKey],
    );
    candidateID = candidate.rows?.[0]?.learning_decision_candidate_id ?? null;
  }

  let supersedesLearningOutcomeID = null;
  if (supersedesLedgerEntryID) {
    const previous = await client.query(
      `SELECT learning_outcome_observation_id
         FROM learning_outcome_observations
        WHERE ledger_entry_id=$1`,
      [supersedesLedgerEntryID],
    );
    supersedesLearningOutcomeID = previous.rows?.[0]?.learning_outcome_observation_id ?? null;
  }

  const inserted = await client.query(
    `INSERT INTO learning_outcome_observations(
       ledger_entry_id,supersedes_learning_outcome_id,routing_decision_event_id,
       learning_decision_candidate_id,plan_id,plan_interval_id,user_id,source_node_id,
       candidate_key,interval_kind,scheduled_start_second,scheduled_end_second,
       actual_status,completion_score,potential_points,earned_points,reason_code,
       evidence,observed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
     ON CONFLICT(ledger_entry_id) DO NOTHING
     RETURNING learning_outcome_observation_id`,
    [
      ledgerEntryID,
      supersedesLearningOutcomeID,
      decisionEventID,
      candidateID,
      planID,
      planIntervalID,
      userID,
      sourceNodeID,
      candidateKey,
      intervalKind,
      Number(startSecond),
      Number(endSecond),
      status,
      completionScore,
      potentialPoints,
      earnedPoints,
      reasonCode,
      JSON.stringify(evidence ?? {}),
      iso(observedAt),
    ],
  );
  const learningOutcomeObservationID = inserted.rows?.[0]?.learning_outcome_observation_id ?? null;
  if (learningOutcomeObservationID) {
    await refreshUserRoutingProfile(client, {
      userID,
      asOf: new Date().toISOString(),
    });
  }
  return {
    learningOutcomeObservationID,
    decisionEventID,
    candidateID,
  };
}

export function pseudonymousUserKey(userID, secret) {
  if (!secret) throw new TypeError('A non-empty export HMAC secret is required.');
  return createHmac('sha256', secret).update(String(userID)).digest('hex');
}
