import { calculateProgressSnapshot, createLedgerEntry } from '../algorithms/progressEngine.js';
import { validateDayGraph } from '../algorithms/dayGraph.js';

function json(value) {
  return JSON.stringify(value ?? {});
}

function potentialTotal(path) {
  return path.intervals.reduce((total, interval) => total + Number(interval.potentialPoints ?? 0), 0);
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
  chosenPath,
  alternativeBranches = [],
  routingContext = {},
  decisionSummary = {},
} = {}) {
  validateDayGraph({ chosenPath, alternativePaths: alternativeBranches });
  const totalPotentialPoints = potentialTotal(chosenPath);
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
    schema: 'fifoo.day-graph.v1',
    dayStartSecond: 0,
    dayEndSecond: 86_400,
    chosenPath,
    alternativeBranches,
  };
  const inserted = await client.query(
    `INSERT INTO day_plan_versions(
       day_map_id,user_id,map_date,plan_revision,plan_status,algorithm_name,
       algorithm_version,rules_hash,total_potential_points,graph_data,
       routing_context,decision_summary,activated_at
     ) VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,NOW())
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
    ],
  );
  const planID = inserted.rows[0].plan_id;
  await insertPath(client, planID, chosenPath, 0);
  for (let index = 0; index < alternativeBranches.length; index += 1) {
    await insertPath(client, planID, alternativeBranches[index], index + 1);
  }

  return {
    planID,
    planRevision,
    totalPotentialPoints,
    intervalCount: chosenPath.intervals.length,
    alternativeCount: alternativeBranches.length,
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
       JOIN day_plan_paths p ON p.plan_id=v.plan_id AND p.path_kind='chosen'
       JOIN day_plan_intervals i ON i.plan_path_id=p.plan_path_id
      WHERE v.day_map_id=$1 AND v.plan_status='active'
      ORDER BY i.sequence_number`,
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
       v.plan_id,i.plan_interval_id,i.algorithm_interval_id,i.start_second,i.end_second,
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
