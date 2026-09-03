import { calculateProgressSnapshot, createLedgerEntry } from '../algorithms/progressEngine.js';
import { stitchPrimaryPaths, validateDayGraph } from '../algorithms/dayGraph.js';
import { optimizeFutureRoutes } from '../algorithms/routingEngine.js';
import { captureLearningOutcome, captureRoutingDecision, routeObservation } from './learningData.js';
import { linkPredictionScoreRun, scoreCandidatesForRouting } from './predictionService.js';

function json(value) {
  return JSON.stringify(value ?? {});
}

function potentialTotal(path) {
  const total = path.intervals.reduce(
    (sum, interval) => sum + Number(interval.potentialPoints ?? 0),
    0,
  );
  return Math.round((total + Number.EPSILON) * 1_000_000) / 1_000_000;
}

async function insertPath(client, planID, path, pathOrder) {
  const result = await client.query(
    `INSERT INTO day_plan_paths(
       plan_id,algorithm_path_id,path_key,path_kind,path_order,
       origin_interval_id,rejoin_interval_id,route_score,expected_progress,path_data
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     RETURNING plan_path_id`,
    [
      planID,
      path.pathID,
      path.pathKey,
      path.pathKind,
      pathOrder,
      path.originIntervalID ?? null,
      path.rejoinIntervalID ?? null,
      path.routeScore ?? null,
      path.expectedProgress ?? null,
      json({
        selectedCandidateKeys: path.selectedCandidateKeys ?? [],
        skippedDecisionGroups: path.skippedDecisionGroups ?? [],
      }),
    ],
  );
  const planPathID = result.rows[0].plan_path_id;

  for (let index = 0; index < path.intervals.length; index += 1) {
    const interval = path.intervals[index];
    await client.query(
      `INSERT INTO day_plan_intervals(
         plan_id,plan_path_id,algorithm_interval_id,source_node_id,interval_key,interval_kind,
         sequence_number,start_second,end_second,progress_category,potential_points,
         planned_progress_start,planned_progress_end,lifecycle_status,completion_evaluator,
         metabolic_context,interval_data
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb
       )`,
      [
        planID,
        planPathID,
        interval.intervalID,
        interval.sourceNodeID ?? null,
        interval.key,
        interval.intervalKind,
        index,
        interval.startSecond,
        interval.endSecond,
        interval.progressCategory,
        interval.potentialPoints ?? 0,
        interval.plannedProgressStart ?? 0,
        interval.plannedProgressEnd ?? 0,
        interval.lifecycleStatus ?? 'planned',
        json(interval.completionEvaluator ?? { type: 'binary' }),
        interval.metabolicContext ?? null,
        json(interval.metadata ?? {}),
      ],
    );
  }
  return planPathID;
}

/**
 * Persists one complete algorithm result without changing the legacy iOS route
 * payload. Callers run this inside the same transaction as node/route writes.
 */
export async function persistCompiledDayPlan(client, {
  dayMap,
  userID,
  mapDate,
  algorithmName,
  algorithmVersion,
  rulesHash,
  completedPath = null,
  chosenPath,
  alternativeBranches = [],
  routingContext = {},
  decisionSummary = {},
  parentPlanID = null,
  rerouteReason = null,
  decisionSecond = null,
  lockedPotentialPoints = 0,
} = {}) {
  validateDayGraph({ completedPath, chosenPath, alternativePaths: alternativeBranches });
  const totalPotentialPoints = potentialTotal(chosenPath) + (completedPath ? potentialTotal(completedPath) : 0);
  if (Math.abs(totalPotentialPoints - 100) > 0.00001) {
    throw new RangeError(`Chosen day plan must contain exactly 100 potential points; received ${totalPotentialPoints}.`);
  }

  await client.query('SELECT day_map_id FROM day_maps WHERE day_map_id=$1 FOR UPDATE', [dayMap.day_map_id]);
  const revisionResult = await client.query(
    `SELECT COALESCE(MAX(plan_revision),0)::int + 1 AS next_revision
       FROM day_plan_versions WHERE day_map_id=$1`,
    [dayMap.day_map_id],
  );
  const planRevision = Number(revisionResult.rows[0].next_revision);

  await client.query(
    `UPDATE day_plan_versions
        SET plan_status='superseded',superseded_at=NOW()
      WHERE day_map_id=$1 AND plan_status='active'`,
    [dayMap.day_map_id],
  );

  const graphData = {
    schema: completedPath ? 'fifoo.day-graph.v2' : 'fifoo.day-graph.v1',
    dayStartSecond: 0,
    dayEndSecond: 86_400,
    completedPath,
    chosenPath,
    alternativeBranches,
  };
  const inserted = await client.query(
    `INSERT INTO day_plan_versions(
       day_map_id,user_id,map_date,plan_revision,plan_status,algorithm_name,
       algorithm_version,rules_hash,total_potential_points,graph_data,
       routing_context,decision_summary,parent_plan_id,reroute_reason,
       decision_second,locked_potential_points,activated_at
     ) VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,NOW())
     RETURNING plan_id,plan_revision`,
    [
      dayMap.day_map_id,
      userID,
      mapDate,
      planRevision,
      algorithmName,
      algorithmVersion,
      rulesHash,
      totalPotentialPoints,
      json(graphData),
      json(routingContext),
      json(decisionSummary),
      parentPlanID,
      rerouteReason,
      decisionSecond,
      lockedPotentialPoints,
    ],
  );
  const planID = inserted.rows[0].plan_id;
  let pathOrder = 0;
  if (completedPath) {
    await insertPath(client, planID, completedPath, pathOrder);
    pathOrder += 1;
  }
  await insertPath(client, planID, chosenPath, pathOrder);
  pathOrder += 1;
  for (let index = 0; index < alternativeBranches.length; index += 1) {
    await insertPath(client, planID, alternativeBranches[index], pathOrder + index);
  }

  return {
    planID,
    planRevision,
    totalPotentialPoints,
    intervalCount: chosenPath.intervals.length + (completedPath?.intervals.length ?? 0),
    alternativeCount: alternativeBranches.length,
  };
}

async function carryForwardCompletedLedger(client, {
  previousPlanID,
  newPlanID,
  userID,
} = {}) {
  await client.query(
    `INSERT INTO day_plan_interval_lineage(
       plan_id,new_plan_interval_id,previous_plan_interval_id,lineage_kind,lineage_data
     )
     SELECT
       $2,new_interval.plan_interval_id,old_interval.plan_interval_id,
       CASE
         WHEN new_interval.interval_data ? 'splitFrom' THEN 'split'
         WHEN old_interval.plan_interval_id IS NOT NULL THEN 'carried'
         ELSE 'replacement'
       END,
       jsonb_build_object('previousPlanID',$1::text)
     FROM day_plan_intervals new_interval
     JOIN day_plan_paths new_path
       ON new_path.plan_path_id=new_interval.plan_path_id
      AND new_path.path_kind='completed'
     LEFT JOIN day_plan_intervals old_interval
       ON old_interval.plan_id=$1
      AND (
        old_interval.algorithm_interval_id=new_interval.algorithm_interval_id
        OR old_interval.algorithm_interval_id::text=new_interval.interval_data->>'splitFrom'
      )
     WHERE new_interval.plan_id=$2
     ON CONFLICT(plan_id,new_plan_interval_id) DO NOTHING`,
    [previousPlanID, newPlanID],
  );
  const result = await client.query(
    `WITH latest AS (
       SELECT DISTINCT ON (l.plan_interval_id)
         l.*,i.algorithm_interval_id
       FROM progress_ledger_entries l
       JOIN day_plan_intervals i ON i.plan_interval_id=l.plan_interval_id
       WHERE l.plan_id=$1
       ORDER BY l.plan_interval_id,l.recorded_at DESC,l.ledger_entry_id DESC
     ), targets AS (
       SELECT i.plan_interval_id,i.algorithm_interval_id,i.potential_points,i.interval_data
       FROM day_plan_intervals i
       JOIN day_plan_paths p ON p.plan_path_id=i.plan_path_id
       WHERE i.plan_id=$2 AND p.path_kind='completed'
     )
     INSERT INTO progress_ledger_entries(
       plan_id,plan_interval_id,user_id,potential_points,completion_score,
       earned_points,outcome_status,reason_code,evidence,observed_at
     )
     SELECT
       $2,t.plan_interval_id,$3,t.potential_points,l.completion_score,
       LEAST(t.potential_points,l.earned_points),l.outcome_status,l.reason_code,
       l.evidence || jsonb_build_object(
         'carriedFromPlanID',$1::text,
         'carriedFromLedgerEntryID',l.ledger_entry_id::text
       ),l.observed_at
     FROM targets t
     JOIN latest l ON l.algorithm_interval_id=t.algorithm_interval_id
       OR l.algorithm_interval_id::text=t.interval_data->>'splitFrom'
     RETURNING ledger_entry_id`,
    [previousPlanID, newPlanID, userID],
  );
  return result.rowCount;
}

function activePrimaryPath(graphData, idSeed) {
  if (!graphData?.chosenPath) throw new RangeError('The active plan has no chosen path.');
  return graphData.completedPath
    ? stitchPrimaryPaths(graphData.completedPath, graphData.chosenPath, {
        idSeed,
        pathKey: 'active-primary',
      })
    : graphData.chosenPath;
}

/**
 * Atomically creates a new plan revision whose completed prefix is immutable
 * and whose chosen/alternative suffixes begin exactly at decisionSecond.
 */
export async function rerouteFutureDayPlan(client, {
  dayMap,
  userID,
  mapDate,
  decisionSecond,
  candidates,
  boundaryOutcome = null,
  rerouteReason = 'context_changed',
  routingContext = {},
  algorithmName = 'fifoo-deterministic-router',
  algorithmVersion = 2,
  rulesHash = null,
  alternativeCount = 2,
  timeZoneIdentifier = null,
  requestID = null,
  occurredAt = new Date().toISOString(),
  predictionRuntimeMode = 'legacy',
} = {}) {
  const active = await client.query(
    `SELECT plan_id,graph_data,algorithm_name,algorithm_version,rules_hash
       FROM day_plan_versions
      WHERE day_map_id=$1 AND plan_status='active'
      FOR UPDATE`,
    [dayMap.day_map_id],
  );
  if (!active.rowCount) throw new RangeError('No active Day Graph exists to reroute.');
  const previous = active.rows[0];
  const idSeed = `${userID}:${mapDate}:reroute:${decisionSecond}`;
  const currentPrimaryPath = activePrimaryPath(previous.graph_data, idSeed);

  if (boundaryOutcome) {
    const boundaryInterval = currentPrimaryPath.intervals.find((interval) => (
      interval.startSecond < Number(decisionSecond) && interval.endSecond > Number(decisionSecond)
    ));
    if (boundaryInterval) {
      await recordProgressOutcome(client, {
        dayMap,
        userID,
        intervalID: boundaryInterval.intervalID,
        actual: boundaryOutcome,
        nowSecond: Number(decisionSecond),
      });
    }
  }

  const decisionProgressSnapshot = await loadProgressSnapshot(client, {
    dayMapID: dayMap.day_map_id,
    nowSecond: Number(decisionSecond),
  });
  const prediction = await scoreCandidatesForRouting(client, {
    configuredMode: predictionRuntimeMode,
    userID,
    dayMap,
    mapDate,
    decisionSecond: Number(decisionSecond),
    candidates,
    routingContext: {
      ...routingContext,
      decisionType: 'future_reroute',
      rerouteReason,
    },
    progressSnapshot: decisionProgressSnapshot,
    requestID,
    occurredAt,
  });
  const optimized = optimizeFutureRoutes({
    currentPrimaryPath,
    decisionSecond,
    candidates: prediction.candidates,
    context: {
      ...routingContext,
      idSeed,
      predictionModeOverride: prediction.predictionMode,
    },
    alternativeCount,
  });
  const persisted = await persistCompiledDayPlan(client, {
    dayMap,
    userID,
    mapDate,
    algorithmName,
    algorithmVersion,
    rulesHash: rulesHash ?? previous.rules_hash,
    completedPath: optimized.completedPath,
    chosenPath: optimized.chosenPath,
    alternativeBranches: optimized.alternativeBranches,
    routingContext,
    decisionSummary: {
      predictionMode: optimized.predictionMode,
      candidateRouteCount: optimized.candidateRouteCount,
      lockedPotentialPoints: optimized.lockedPotentialPoints,
      remainingPotentialPoints: optimized.remainingPotentialPoints,
      predictionModel: prediction.model,
    },
    parentPlanID: previous.plan_id,
    rerouteReason,
    decisionSecond: optimized.decisionSecond,
    lockedPotentialPoints: optimized.lockedPotentialPoints,
  });
  const carriedLedgerEntryCount = await carryForwardCompletedLedger(client, {
    previousPlanID: previous.plan_id,
    newPlanID: persisted.planID,
    userID,
  });
  const learningDecision = await captureRoutingDecision(client, {
    planID: persisted.planID,
    parentPlanID: previous.plan_id,
    planRevision: persisted.planRevision,
    dayMap,
    userID,
    mapDate,
    timeZoneIdentifier,
    decisionType: 'future_reroute',
    decisionSecond: optimized.decisionSecond,
    rerouteReason,
    algorithmName,
    algorithmVersion,
    rulesHash: rulesHash ?? previous.rules_hash,
    predictionMode: optimized.predictionMode,
    predictionModelName: prediction.model?.name ?? 'completion-prior-blend',
    predictionModelVersion: prediction.model?.version ?? 1,
    routingContext,
    progressSnapshot: decisionProgressSnapshot,
    requestID,
    occurredAt,
    candidates: optimized.candidateObservations ?? candidates,
    routes: optimized.routeObservations ?? [
      routeObservation(optimized.chosenPath, 0, { selected: true, routeKind: 'chosen' }),
      ...optimized.alternativeBranches.map((path, index) => (
        routeObservation(path, index + 1, { selected: false, routeKind: 'alternative' })
      )),
    ],
  });
  await linkPredictionScoreRun(
    client,
    prediction.predictionScoreRunIDs?.length ? prediction.predictionScoreRunIDs : prediction.predictionScoreRunID,
    learningDecision.decisionEventID,
  );
  const progressSnapshot = await loadProgressSnapshot(client, {
    dayMapID: dayMap.day_map_id,
    nowSecond: optimized.decisionSecond,
  });
  return {
    ...persisted,
    decisionSecond: optimized.decisionSecond,
    rerouteReason,
    effectiveAt: new Date().toISOString(),
    lockedPotentialPoints: optimized.lockedPotentialPoints,
    remainingPotentialPoints: optimized.remainingPotentialPoints,
    carriedLedgerEntryCount,
    progressSnapshot,
    dayPlan: {
      schema: 'fifoo.day-graph.v2',
      dayStartSecond: 0,
      dayEndSecond: 86_400,
      completedPath: optimized.completedPath,
      chosenPath: optimized.chosenPath,
      alternativeBranches: optimized.alternativeBranches,
    },
  };
}

/**
 * Loads the currently active authoritative Day Graph and its immutable-ledger
 * progress projection. Used after initial sync, reconnect, conflict recovery,
 * and manual refresh so iOS never has to reconstruct a plan from legacy route
 * state.
 */
export async function loadAuthoritativeDayPlanState(client, {
  dayMap,
  nowSecond = null,
} = {}) {
  const result = await client.query(
    `SELECT plan_id,plan_revision,graph_data,reroute_reason,decision_second,activated_at
       FROM day_plan_versions
      WHERE day_map_id=$1 AND plan_status='active'
      ORDER BY plan_revision DESC
      LIMIT 1`,
    [dayMap.day_map_id],
  );
  if (!result.rowCount) return null;

  const row = result.rows[0];
  const effectiveSecond = Number.isFinite(Number(nowSecond))
    ? Number(nowSecond)
    : Number(dayMap.current_time_seconds ?? row.decision_second ?? 0);
  const progressSnapshot = await loadProgressSnapshot(client, {
    dayMapID: dayMap.day_map_id,
    nowSecond: effectiveSecond,
  });

  return {
    dayPlan: row.graph_data,
    progressSnapshot,
    planRevision: Number(row.plan_revision),
    rerouteReason: row.reroute_reason ?? null,
    decisionSecond: row.decision_second == null ? null : Number(row.decision_second),
    effectiveAt: row.activated_at == null ? null : new Date(row.activated_at).toISOString(),
  };
}

export async function activeDayPlanExists(client, dayMapID, rulesHash) {
  const result = await client.query(
    `SELECT 1
       FROM day_plan_versions
      WHERE day_map_id=$1 AND plan_status='active' AND rules_hash=$2
      LIMIT 1`,
    [dayMapID, rulesHash],
  );
  return result.rowCount > 0;
}

async function activePlanRows(client, dayMapID) {
  const [plan, intervals, ledger] = await Promise.all([
    client.query(
      `SELECT plan_id,total_potential_points
         FROM day_plan_versions
        WHERE day_map_id=$1 AND plan_status='active'`,
      [dayMapID],
    ),
    client.query(
      `SELECT
         i.plan_interval_id,i.algorithm_interval_id AS interval_id,i.start_second,i.end_second,
         i.potential_points,i.completion_evaluator,i.interval_data,
         p.expected_progress
       FROM day_plan_versions v
       JOIN day_plan_paths p ON p.plan_id=v.plan_id AND p.path_kind IN ('completed','chosen')
       JOIN day_plan_intervals i ON i.plan_path_id=p.plan_path_id
      WHERE v.day_map_id=$1 AND v.plan_status='active'
      ORDER BY i.start_second,i.sequence_number`,
      [dayMapID],
    ),
    client.query(
      `SELECT DISTINCT ON (l.plan_interval_id)
         l.ledger_entry_id AS entry_id,
         i.algorithm_interval_id AS interval_id,
         l.potential_points,l.completion_score,l.earned_points,
         l.outcome_status AS status,l.reason_code,l.observed_at,l.supersedes_entry_id
       FROM day_plan_versions v
       JOIN progress_ledger_entries l ON l.plan_id=v.plan_id
       JOIN day_plan_intervals i ON i.plan_interval_id=l.plan_interval_id
      WHERE v.day_map_id=$1 AND v.plan_status='active'
      ORDER BY l.plan_interval_id,l.recorded_at DESC,l.ledger_entry_id DESC`,
      [dayMapID],
    ),
  ]);
  if (!plan.rowCount) return null;
  return { plan: plan.rows[0], intervals: intervals.rows, ledger: ledger.rows };
}

export async function loadProgressSnapshot(client, { dayMapID, nowSecond = 0 } = {}) {
  const rows = await activePlanRows(client, dayMapID);
  if (!rows) return null;
  return calculateProgressSnapshot({
    intervals: rows.intervals.map((row) => ({
      intervalID: row.interval_id,
      startSecond: Number(row.start_second),
      endSecond: Number(row.end_second),
      potentialPoints: Number(row.potential_points),
      expectedCompletionProbability: row.interval_data?.completionProbability,
    })),
    ledgerEntries: rows.ledger.map((row) => ({
      entryID: row.entry_id,
      intervalID: row.interval_id,
      potentialPoints: Number(row.potential_points),
      completionScore: Number(row.completion_score),
      earnedPoints: Number(row.earned_points),
      status: row.status,
      reasonCode: row.reason_code,
      observedAt: row.observed_at,
      supersedesEntryID: row.supersedes_entry_id,
    })),
    nowSecond,
  });
}

export async function recordProgressOutcome(client, {
  dayMap,
  userID,
  intervalID,
  actual,
  nowSecond,
  observedAt = new Date().toISOString(),
} = {}) {
  const intervalResult = await client.query(
    `SELECT
       v.plan_id,i.plan_interval_id,i.algorithm_interval_id,i.source_node_id,
       i.interval_key,i.interval_kind,i.start_second,i.end_second,
       i.potential_points,i.completion_evaluator,
       latest.ledger_entry_id AS latest_entry_id
     FROM day_plan_versions v
     JOIN day_plan_intervals i ON i.plan_id=v.plan_id
     LEFT JOIN LATERAL (
       SELECT ledger_entry_id
         FROM progress_ledger_entries l
        WHERE l.plan_interval_id=i.plan_interval_id
        ORDER BY l.recorded_at DESC,l.ledger_entry_id DESC
        LIMIT 1
     ) latest ON TRUE
    WHERE v.day_map_id=$1
      AND v.plan_status='active'
      AND i.algorithm_interval_id=$2
    LIMIT 1
    FOR UPDATE OF i`,
    [dayMap.day_map_id, intervalID],
  );
  if (!intervalResult.rowCount) throw new RangeError('The active day plan does not contain this interval.');
  const row = intervalResult.rows[0];
  const entry = createLedgerEntry({
    intervalID: row.algorithm_interval_id,
    startSecond: Number(row.start_second),
    endSecond: Number(row.end_second),
    potentialPoints: Number(row.potential_points),
    completionEvaluator: row.completion_evaluator,
  }, actual, {
    nowSecond,
    observedAt,
    supersedesEntryID: row.latest_entry_id,
  });

  const inserted = await client.query(
    `INSERT INTO progress_ledger_entries(
       plan_id,plan_interval_id,user_id,potential_points,completion_score,
       earned_points,outcome_status,reason_code,evidence,observed_at,supersedes_entry_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     RETURNING ledger_entry_id`,
    [
      row.plan_id,
      row.plan_interval_id,
      userID,
      entry.potentialPoints,
      entry.completionScore,
      entry.earnedPoints,
      entry.status,
      entry.reasonCode,
      json(entry.evidence),
      entry.observedAt,
      row.latest_entry_id,
    ],
  );
  entry.entryID = inserted.rows[0].ledger_entry_id;

  await captureLearningOutcome(client, {
    ledgerEntryID: entry.entryID,
    supersedesLedgerEntryID: row.latest_entry_id,
    planID: row.plan_id,
    planIntervalID: row.plan_interval_id,
    userID,
    sourceNodeID: row.source_node_id,
    candidateKey: row.interval_key,
    intervalKind: row.interval_kind,
    startSecond: row.start_second,
    endSecond: row.end_second,
    status: entry.status,
    completionScore: entry.completionScore,
    potentialPoints: entry.potentialPoints,
    earnedPoints: entry.earnedPoints,
    reasonCode: entry.reasonCode,
    evidence: entry.evidence,
    observedAt: entry.observedAt,
  });

  const snapshot = await loadProgressSnapshot(client, { dayMapID: dayMap.day_map_id, nowSecond });
  await client.query(
    `UPDATE day_maps SET current_progress=$2,updated_at=NOW() WHERE day_map_id=$1`,
    [dayMap.day_map_id, snapshot.dayProgress * 100],
  );
  return { ledgerEntry: entry, progressSnapshot: snapshot };
}

export async function recordNodeProgressOutcome(client, {
  dayMap,
  userID,
  nodeID,
  action,
  nowSecond,
  evidence = {},
} = {}) {
  const normalizedAction = String(action ?? '').trim().toLowerCase();
  if (!['complete', 'completed', 'done', 'skip', 'skipped'].includes(normalizedAction)) return null;

  const interval = await client.query(
    `SELECT i.algorithm_interval_id
       FROM day_plan_versions v
       JOIN day_plan_paths p ON p.plan_id=v.plan_id AND p.path_kind='chosen'
       JOIN day_plan_intervals i ON i.plan_path_id=p.plan_path_id
      WHERE v.day_map_id=$1
        AND v.plan_status='active'
        AND i.source_node_id=$2
      LIMIT 1`,
    [dayMap.day_map_id, nodeID],
  );
  if (!interval.rowCount) return null;

  const completed = ['complete', 'completed', 'done'].includes(normalizedAction);
  return recordProgressOutcome(client, {
    dayMap,
    userID,
    intervalID: interval.rows[0].algorithm_interval_id,
    actual: completed
      ? { completed: true, status: 'completed', evidence }
      : { status: 'skipped', reasonCode: 'user_skipped', evidence },
    nowSecond,
  });
}
