import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { activityContent, activityEndTimeSeconds, gameNodeID, nodeTimeSeconds } from '../lib/nodeCodec.js';
import { bumpRevision, ensureDayMap, lockDayMap } from './dayMaps.js';
import { persistNode } from './nodes.js';
import { loadAuthoritativeDayPlanState, rerouteFutureDayPlan } from './dayPlanning.js';
import {
  SUPPORT_PLANNER_SCHEMA,
  addLocalDays,
  buildSupportTaskNode,
  findSupportSlot,
  localDayDifference,
  supportRequirementsForNode,
  targetSecondsFromNow,
} from './activitySupportRules.js';

function localDateString(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localTimeSeconds(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return (Number(values.hour) % 24) * 3600 + Number(values.minute) * 60 + Number(values.second);
}

function supportMetadata(node) {
  return activityContent(node)?.supportPlan ?? null;
}

function intervalForNode(node) {
  const startSecond = nodeTimeSeconds(node);
  const activity = activityContent(node);
  let endSecond = activityEndTimeSeconds(activity);
  if (!Number.isFinite(Number(endSecond)) || Number(endSecond) <= startSecond) {
    endSecond = Math.min(86_400, startSecond + 30 * 60);
  }
  return { startSecond, endSecond: Math.min(86_400, Number(endSecond)), nodeID: gameNodeID(node) };
}

async function dayNodeRows(client, dayMapID) {
  const result = await client.query(
    `SELECT node_id::text,node_data,time_seconds
       FROM day_map_nodes
      WHERE day_map_id=$1 AND is_enabled=TRUE
      ORDER BY time_seconds,node_id`,
    [dayMapID],
  );
  return result.rows;
}

async function supportNodeIsRouted(client, dayMapID, supportNodeID) {
  if (!dayMapID || !supportNodeID) return false;
  const result = await client.query(
    `SELECT graph_data
       FROM day_plan_versions
      WHERE day_map_id=$1 AND plan_status='active'
      ORDER BY plan_revision DESC
      LIMIT 1`,
    [dayMapID],
  );
  const intervals = result.rows[0]?.graph_data?.chosenPath?.intervals ?? [];
  return intervals.some((interval) => String(interval.sourceNodeID ?? '') === String(supportNodeID));
}

async function targetRows(client, { userID, anchorMapDate, horizonEndMapDate }) {
  const result = await client.query(
    `SELECT dm.day_map_id,
            dm.map_date::text AS map_date,
            dm.timezone,
            n.node_id::text,
            n.node_data,
            n.time_seconds
       FROM day_maps dm
       JOIN day_map_nodes n ON n.day_map_id=dm.day_map_id
      WHERE dm.user_id=$1
        AND dm.map_date BETWEEN $2::date AND $3::date
        AND n.is_enabled=TRUE
        AND n.node_kind='activityMeal'
      ORDER BY dm.map_date,n.time_seconds,n.node_id`,
    [userID, anchorMapDate, horizonEndMapDate],
  );
  return result.rows;
}

async function existingEdges(client, userID) {
  const result = await client.query(
    `SELECT e.support_edge_id::text,
            e.target_node_id::text,
            e.support_node_id::text,
            e.support_day_map_id,
            e.rule_key,
            e.support_status,
            e.support_metadata,
            tdm.map_date::text AS target_map_date,
            sdm.map_date::text AS support_map_date
       FROM activity_support_edges e
       JOIN day_maps tdm ON tdm.day_map_id=e.target_day_map_id
       LEFT JOIN day_maps sdm ON sdm.day_map_id=e.support_day_map_id
      WHERE e.user_id=$1
        AND e.support_status <> 'superseded'`,
    [userID],
  );
  return result.rows;
}

async function deleteSupportNode(client, row, changesByDate) {
  if (!row?.support_node_id) return;
  const found = await client.query(
    `SELECT n.node_id::text,dm.day_map_id,dm.map_date::text AS map_date
       FROM day_map_nodes n
       JOIN day_maps dm ON dm.day_map_id=n.day_map_id
      WHERE n.node_id=$1`,
    [row.support_node_id],
  );
  if (!found.rowCount) return;
  await client.query('DELETE FROM day_map_nodes WHERE node_id=$1', [row.support_node_id]);
  const info = found.rows[0];
  const change = changesByDate.get(info.map_date) ?? {
    dayMapID: info.day_map_id,
    upsertedNodes: [],
    deletedNodeIDs: [],
  };
  change.deletedNodeIDs.push(row.support_node_id);
  changesByDate.set(info.map_date, change);
}

async function cleanupOrphanGeneratedNodes(client, userID, changesByDate) {
  const orphaned = await client.query(
    `SELECT n.node_id::text,dm.day_map_id,dm.map_date::text AS map_date
       FROM day_map_nodes n
       JOIN day_maps dm ON dm.day_map_id=n.day_map_id
      WHERE dm.user_id=$1
        AND n.node_data #>> '{content,activity,_0,supportPlan,isGenerated}' = 'true'
        AND NOT EXISTS (
          SELECT 1
            FROM day_map_nodes target
           WHERE target.node_id::text = n.node_data #>> '{content,activity,_0,supportPlan,targetNodeID}'
        )`,
    [userID],
  );
  for (const row of orphaned.rows) {
    await client.query('DELETE FROM day_map_nodes WHERE node_id=$1', [row.node_id]);
    const change = changesByDate.get(row.map_date) ?? {
      dayMapID: row.day_map_id,
      upsertedNodes: [],
      deletedNodeIDs: [],
    };
    change.deletedNodeIDs.push(row.node_id);
    changesByDate.set(row.map_date, change);
  }
}

function possibleSupportDates({ anchorMapDate, targetMapDate, requirement }) {
  const targetDelta = localDayDifference(anchorMapDate, targetMapDate);
  if (targetDelta < 0) return [];

  const dates = [];
  const preferredPrevious = addLocalDays(targetMapDate, -1);
  if (preferredPrevious >= anchorMapDate) dates.push(preferredPrevious);

  for (let offset = 2; offset <= Number(requirement.maxAdvanceDays ?? 1); offset += 1) {
    const date = addLocalDays(targetMapDate, -offset);
    if (date >= anchorMapDate && !dates.includes(date)) dates.push(date);
  }

  if (!dates.includes(targetMapDate)) dates.push(targetMapDate);
  return dates;
}

function schedulingBounds({
  supportMapDate,
  targetMapDate,
  targetStartSecond,
  anchorMapDate,
  nowSecond,
  requirement,
  existingIntervals,
}) {
  let earliestStartSecond = 7 * 3600;
  let latestEndSecond = 22 * 3600;

  if (supportMapDate === anchorMapDate) {
    earliestStartSecond = Math.max(earliestStartSecond, Number(nowSecond) + 15 * 60);
    const active = existingIntervals.find((interval) => (
      interval.startSecond <= Number(nowSecond) && interval.endSecond > Number(nowSecond)
    ));
    if (active) earliestStartSecond = Math.max(earliestStartSecond, active.endSecond);
  }

  if (supportMapDate === targetMapDate) {
    latestEndSecond = Math.min(
      latestEndSecond,
      Number(targetStartSecond) - Number(requirement.sameDayLeadSeconds ?? 0),
    );
  } else {
    latestEndSecond = Math.min(
      latestEndSecond,
      Number(requirement.latestPreviousDayEndSecond ?? latestEndSecond),
    );
  }

  return { earliestStartSecond, latestEndSecond };
}

async function upsertEdge(client, {
  userID,
  targetRow,
  supportDayMap,
  supportNodeID,
  requirement,
  status,
  metadata,
  timeZoneIdentifier,
}) {
  const result = await client.query(
    `INSERT INTO activity_support_edges(
       user_id,target_day_map_id,target_node_id,support_day_map_id,support_node_id,
       rule_key,relationship_type,confidence,required_by,support_status,support_metadata
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       (($9::date + ($10::double precision * interval '1 second')) AT TIME ZONE $11),
       $12,$13::jsonb
     )
     ON CONFLICT(user_id,target_node_id,rule_key) DO UPDATE SET
       target_day_map_id=EXCLUDED.target_day_map_id,
       support_day_map_id=EXCLUDED.support_day_map_id,
       support_node_id=EXCLUDED.support_node_id,
       relationship_type=EXCLUDED.relationship_type,
       confidence=EXCLUDED.confidence,
       required_by=EXCLUDED.required_by,
       support_status=EXCLUDED.support_status,
       support_metadata=EXCLUDED.support_metadata,
       updated_at=NOW()
     RETURNING support_edge_id::text`,
    [
      userID,
      targetRow.day_map_id,
      targetRow.node_id,
      supportDayMap?.day_map_id ?? null,
      supportNodeID ?? null,
      requirement.ruleKey,
      requirement.relationshipType,
      requirement.confidence,
      targetRow.map_date,
      Number(targetRow.time_seconds),
      timeZoneIdentifier,
      status,
      JSON.stringify(metadata ?? {}),
    ],
  );
  return result.rows[0].support_edge_id;
}

async function loadSupportState(client, {
  userID,
  anchorMapDate,
  horizonEndMapDate,
  horizonHours,
}) {
  const result = await client.query(
    `SELECT e.support_edge_id::text,
            e.target_node_id::text,
            e.support_node_id::text,
            e.rule_key,
            e.relationship_type,
            e.confidence,
            e.required_by,
            e.support_status,
            e.support_metadata,
            tdm.map_date::text AS target_map_date,
            sdm.map_date::text AS support_map_date,
            sn.node_data #>> '{content,activity,_0,title}' AS support_title
       FROM activity_support_edges e
       JOIN day_maps tdm ON tdm.day_map_id=e.target_day_map_id
       LEFT JOIN day_maps sdm ON sdm.day_map_id=e.support_day_map_id
       LEFT JOIN day_map_nodes sn ON sn.node_id=e.support_node_id
      WHERE e.user_id=$1
        AND tdm.map_date BETWEEN $2::date AND $3::date
        AND e.support_status <> 'superseded'
      ORDER BY tdm.map_date,e.required_by,e.created_at`,
    [userID, anchorMapDate, horizonEndMapDate],
  );
  const items = result.rows.map((row) => ({
    supportEdgeID: row.support_edge_id,
    targetNodeID: row.target_node_id,
    supportNodeID: row.support_node_id ?? null,
    targetMapDate: row.target_map_date,
    supportMapDate: row.support_map_date ?? null,
    ruleKey: row.rule_key,
    relationshipType: row.relationship_type,
    status: row.support_status,
    confidence: Number(row.confidence ?? 0),
    requiredBy: row.required_by ? new Date(row.required_by).toISOString() : null,
    reason: row.support_metadata?.reason ?? '',
    supportTitle: row.support_title ?? row.support_metadata?.supportTitle ?? null,
  }));
  return {
    schema: SUPPORT_PLANNER_SCHEMA,
    generatedAt: new Date().toISOString(),
    anchorMapDate,
    horizonHours,
    items,
    summary: {
      scheduled: items.filter((item) => item.status === 'scheduled').length,
      completed: items.filter((item) => item.status === 'completed').length,
      blocked: items.filter((item) => item.status === 'blocked').length,
      dismissed: items.filter((item) => item.status === 'dismissed').length,
    },
  };
}

function candidateFromInterval(interval) {
  return {
    key: String(interval.candidateKey ?? interval.key),
    candidateKey: String(interval.candidateKey ?? interval.key),
    decisionGroup: String(interval.candidateKey ?? interval.key),
    kind: interval.intervalKind ?? 'task',
    sourceNodeID: interval.sourceNodeID,
    required: true,
    fixedStartSecond: Number(interval.startSecond),
    earliestStartSecond: Number(interval.startSecond),
    latestEndSecond: Number(interval.endSecond),
    durationSeconds: Math.max(1, Number(interval.endSecond) - Number(interval.startSecond)),
    progressCategory: interval.progressCategory ?? 'routine',
    progressWeightHint: Math.max(0.1, Number(interval.potentialPoints ?? interval.progressWeightHint ?? 1)),
    completionProbability: 0.75,
  };
}

function supportCandidate(node) {
  const metadata = supportMetadata(node);
  const interval = intervalForNode(node);
  const key = `support:${metadata.ruleKey}:${metadata.targetNodeID}`;
  return {
    key,
    candidateKey: key,
    decisionGroup: key,
    kind: 'task',
    sourceNodeID: gameNodeID(node),
    required: true,
    fixedStartSecond: interval.startSecond,
    earliestStartSecond: interval.startSecond,
    latestEndSecond: interval.endSecond,
    durationSeconds: Math.max(1, interval.endSecond - interval.startSecond),
    progressCategory: 'routine',
    progressWeightHint: 1,
    completionProbability: Math.max(0.05, Math.min(0.99, Number(metadata.confidence ?? 0.75))),
    isSupportAction: true,
    supportRuleKey: metadata.ruleKey,
    supportRelationshipType: metadata.relationshipType,
    supportTargetNodeID: metadata.targetNodeID,
    supportConfidence: Number(metadata.confidence ?? 0.75),
  };
}

async function rerouteSupportDay(client, {
  userID,
  dayMap,
  mapDate,
  timeZoneIdentifier,
  anchorMapDate,
  nowSecond,
}) {
  const active = await client.query(
    `SELECT graph_data
       FROM day_plan_versions
      WHERE day_map_id=$1 AND plan_status='active'
      LIMIT 1`,
    [dayMap.day_map_id],
  );
  if (!active.rowCount) return { dayPlanState: null, skippedReason: 'no_active_day_plan' };

  const graph = active.rows[0].graph_data;
  const chosen = graph?.chosenPath;
  if (!chosen?.intervals) return { dayPlanState: null, skippedReason: 'invalid_active_day_plan' };

  // The existing future-only rerouter requires a strict interior boundary.
  // For a future day, second 1 is effectively the full mutable day while still
  // preserving the Day Graph invariant that decisionSecond is in (0, 86400).
  const decisionSecond = Math.max(
    1,
    Math.min(86_399, mapDate === anchorMapDate ? Number(nowSecond) : 1),
  );
  const activeSourceInterval = chosen.intervals.find((interval) => (
    interval.sourceNodeID
      && Number(interval.startSecond) < decisionSecond
      && Number(interval.endSecond) > decisionSecond
  ));
  if (activeSourceInterval) {
    return { dayPlanState: null, skippedReason: 'active_activity_not_preempted' };
  }

  const nodeRows = await dayNodeRows(client, dayMap.day_map_id);
  const nodeIDs = new Set(nodeRows.map((row) => String(row.node_id)));
  const candidates = [];
  const represented = new Set();
  for (const interval of chosen.intervals) {
    if (!interval.sourceNodeID) continue;
    if (!nodeIDs.has(String(interval.sourceNodeID))) continue;
    if (Number(interval.startSecond) < decisionSecond) continue;
    const candidate = candidateFromInterval(interval);
    candidates.push(candidate);
    represented.add(String(interval.sourceNodeID));
  }

  for (const row of nodeRows) {
    const node = row.node_data;
    const metadata = supportMetadata(node);
    if (!metadata?.isGenerated || represented.has(String(row.node_id))) continue;
    if (nodeTimeSeconds(node) < decisionSecond) continue;
    candidates.push(supportCandidate(node));
  }

  if (!candidates.length) return { dayPlanState: null, skippedReason: 'no_future_candidates' };

  await client.query('SAVEPOINT support_plan_reroute');
  try {
    const result = await rerouteFutureDayPlan(client, {
      dayMap,
      userID,
      mapDate,
      decisionSecond,
      candidates,
      rerouteReason: 'support_plan_changed',
      routingContext: {
        mode: 'activity-support-mvp',
        timeZoneIdentifier,
        defaultTransitionSeconds: 0,
      },
      alternativeCount: 2,
      timeZoneIdentifier,
      predictionRuntimeMode: config.predictionRuntimeMode,
    });
    await client.query('RELEASE SAVEPOINT support_plan_reroute');
    return { dayPlanState: result, skippedReason: null };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT support_plan_reroute');
    await client.query('RELEASE SAVEPOINT support_plan_reroute');
    return { dayPlanState: null, skippedReason: `reroute_failed:${error.message}` };
  }
}

/**
 * Runs the deterministic MVP support planner for one user. It uses a separate
 * transaction because it may modify multiple Day Maps. The returned `changes`
 * are broadcast only after commit, preserving the existing socket mutation
 * acknowledgement contract.
 */
export async function refreshActivitySupportPlanForUser({
  userID,
  timeZoneIdentifier,
  now = new Date(),
  horizonHours = config.activitySupportHorizonHours,
} = {}) {
  const effectiveHorizonHours = Math.max(24, Math.min(168, Number(horizonHours) || 72));
  const anchorMapDate = localDateString(timeZoneIdentifier, now);
  const nowSecond = localTimeSeconds(timeZoneIdentifier, now);
  const horizonEndMapDate = addLocalDays(anchorMapDate, Math.ceil(effectiveHorizonHours / 24));

  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`fifoo-support-plan:${userID}`]);

    const changesByDate = new Map();
    await cleanupOrphanGeneratedNodes(client, userID, changesByDate);

    const [targets, edges] = await Promise.all([
      targetRows(client, { userID, anchorMapDate, horizonEndMapDate }),
      existingEdges(client, userID),
    ]);
    const edgeByKey = new Map(edges.map((edge) => [`${edge.target_node_id}:${edge.rule_key}`, edge]));
    const desiredKeys = new Set();
    let targetCount = 0;
    let scheduledCount = 0;
    let blockedCount = 0;

    for (const targetRow of targets) {
      if (targetSecondsFromNow({
        anchorMapDate,
        nowSecond,
        targetMapDate: targetRow.map_date,
        targetNode: targetRow.node_data,
      }) <= 0) continue;
      if (targetSecondsFromNow({
        anchorMapDate,
        nowSecond,
        targetMapDate: targetRow.map_date,
        targetNode: targetRow.node_data,
      }) > effectiveHorizonHours * 3600) continue;

      const requirements = supportRequirementsForNode(targetRow.node_data);
      if (!requirements.length) continue;
      targetCount += 1;

      for (const requirement of requirements) {
        const edgeKey = `${targetRow.node_id}:${requirement.ruleKey}`;
        desiredKeys.add(edgeKey);
        const existing = edgeByKey.get(edgeKey);
        const targetStartSecond = Number(targetRow.time_seconds ?? nodeTimeSeconds(targetRow.node_data));
        const priorMetadata = existing?.support_metadata ?? {};
        const supportElapsed = existing?.support_map_date
          && (existing.support_map_date < anchorMapDate
            || (existing.support_map_date === anchorMapDate
              && Number(priorMetadata.supportEndSecond ?? 0) <= nowSecond));
        const canReuse = existing?.support_status === 'scheduled'
          && existing?.support_node_id
          && !supportElapsed
          && priorMetadata.targetMapDate === targetRow.map_date
          && Number(priorMetadata.targetStartSecond) === targetStartSecond;
        if (canReuse) {
          scheduledCount += 1;
          const isRouted = await supportNodeIsRouted(
            client,
            existing.support_day_map_id,
            existing.support_node_id,
          );
          if (!isRouted && existing.support_map_date && existing.support_day_map_id) {
            const change = changesByDate.get(existing.support_map_date) ?? {
              dayMapID: existing.support_day_map_id,
              upsertedNodes: [],
              deletedNodeIDs: [],
            };
            change.routeCheckOnly = true;
            changesByDate.set(existing.support_map_date, change);
          }
          continue;
        }

        if (existing?.support_node_id) await deleteSupportNode(client, existing, changesByDate);

        let scheduled = null;
        for (const supportMapDate of possibleSupportDates({ anchorMapDate, targetMapDate: targetRow.map_date, requirement })) {
          const supportDayMap = await ensureDayMap(client, {
            userID,
            mapDate: supportMapDate,
            timeZoneIdentifier,
          });
          await lockDayMap(client, supportDayMap.day_map_id);
          const rows = await dayNodeRows(client, supportDayMap.day_map_id);
          const intervals = rows.map((row) => intervalForNode(row.node_data));
          const bounds = schedulingBounds({
            supportMapDate,
            targetMapDate: targetRow.map_date,
            targetStartSecond,
            anchorMapDate,
            nowSecond,
            requirement,
            existingIntervals: intervals,
          });
          const slot = findSupportSlot({
            existingIntervals: intervals,
            earliestStartSecond: bounds.earliestStartSecond,
            latestEndSecond: bounds.latestEndSecond,
            durationSeconds: requirement.durationSeconds,
            preferredStartSecond: requirement.preferredStartSecond,
          });
          if (!slot) continue;

          const node = buildSupportTaskNode({
            userID,
            supportMapDate,
            slot,
            targetNodeID: targetRow.node_id,
            targetMapDate: targetRow.map_date,
            targetStartSecond,
            requirement,
          });
          const persisted = await persistNode(client, {
            dayMap: supportDayMap,
            userID,
            context: { mapDate: supportMapDate, timeZoneIdentifier },
            node,
          });
          const metadata = {
            schema: SUPPORT_PLANNER_SCHEMA,
            targetMapDate: targetRow.map_date,
            targetStartSecond,
            supportMapDate,
            supportStartSecond: slot.startSecond,
            supportEndSecond: slot.endSecond,
            actionKind: requirement.actionKind,
            supportTitle: requirement.title,
            reason: requirement.reason,
          };
          const supportEdgeID = await upsertEdge(client, {
            userID,
            targetRow,
            supportDayMap,
            supportNodeID: persisted.nodeID,
            requirement,
            status: 'scheduled',
            metadata,
            timeZoneIdentifier,
          });
          const change = changesByDate.get(supportMapDate) ?? {
            dayMapID: supportDayMap.day_map_id,
            upsertedNodes: [],
            deletedNodeIDs: [],
          };
          change.upsertedNodes.push(persisted.node);
          changesByDate.set(supportMapDate, change);
          scheduled = { supportEdgeID, supportDayMap, node: persisted.node };
          scheduledCount += 1;
          break;
        }

        if (!scheduled) {
          blockedCount += 1;
          await upsertEdge(client, {
            userID,
            targetRow,
            supportDayMap: null,
            supportNodeID: null,
            requirement,
            status: 'blocked',
            metadata: {
              schema: SUPPORT_PLANNER_SCHEMA,
              targetMapDate: targetRow.map_date,
              targetStartSecond,
              reason: requirement.reason,
              supportTitle: requirement.title,
              blockedReason: 'no_non_overlapping_slot_before_deadline',
            },
            timeZoneIdentifier,
          });
        }
      }
    }

    for (const edge of edges) {
      const key = `${edge.target_node_id}:${edge.rule_key}`;
      if (desiredKeys.has(key)) continue;
      if (edge.support_node_id) await deleteSupportNode(client, edge, changesByDate);
      await client.query(
        `UPDATE activity_support_edges
            SET support_status='superseded',support_node_id=NULL,support_day_map_id=NULL,updated_at=NOW()
          WHERE support_edge_id=$1`,
        [edge.support_edge_id],
      );
    }

    const changes = [];
    let rerouteFailureCount = 0;
    for (const [mapDate, change] of [...changesByDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const dayMap = await lockDayMap(client, change.dayMapID);
      const reroute = await rerouteSupportDay(client, {
        userID,
        dayMap,
        mapDate,
        timeZoneIdentifier,
        anchorMapDate,
        nowSecond,
      });
      if (reroute.skippedReason?.startsWith('reroute_failed:')) rerouteFailureCount += 1;
      const hasNodeMutations = (change.upsertedNodes?.length ?? 0) > 0
        || (change.deletedNodeIDs?.length ?? 0) > 0;
      if (!hasNodeMutations && !reroute.dayPlanState) continue;
      const revision = await bumpRevision(client, dayMap.day_map_id);
      const dayPlanState = reroute.dayPlanState
        ? { ...reroute.dayPlanState, revision }
        : await loadAuthoritativeDayPlanState(client, {
            dayMap,
            nowSecond: mapDate === anchorMapDate ? nowSecond : 0,
          }).then((state) => (state ? { ...state, revision } : null));
      changes.push({
        mapDate,
        revision,
        upsertedNodes: change.upsertedNodes,
        deletedNodeIDs: [...new Set(change.deletedNodeIDs)],
        dayPlanState,
        rerouteSkippedReason: reroute.skippedReason,
      });
    }

    const state = await loadSupportState(client, {
      userID,
      anchorMapDate,
      horizonEndMapDate,
      horizonHours: effectiveHorizonHours,
    });
    const runStatus = blockedCount || rerouteFailureCount ? 'partial' : 'success';
    await client.query(
      `INSERT INTO activity_support_plan_runs(
         user_id,anchor_map_date,horizon_hours,run_status,target_count,scheduled_count,blocked_count,summary,finished_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())`,
      [
        userID,
        anchorMapDate,
        effectiveHorizonHours,
        runStatus,
        targetCount,
        scheduledCount,
        blockedCount,
        JSON.stringify({ changedDayCount: changes.length, rerouteFailureCount }),
      ],
    );

    return { state, changes, runStatus };
  });
}

export async function recordActivitySupportOutcome(client, { nodeID, action } = {}) {
  const normalized = String(action ?? '').trim().toLowerCase();
  if (!nodeID || !normalized) return;
  const isCompleted = ['complete', 'completed', 'done'].includes(normalized);
  const isDismissed = ['skip', 'skipped'].includes(normalized);
  if (!isCompleted && !isDismissed) return;

  await client.query(
    `UPDATE activity_support_edges
        SET support_status=CASE
              WHEN support_node_id=$1 THEN $2
              ELSE support_status
            END,
            support_metadata=CASE
              WHEN target_node_id=$1 THEN jsonb_set(
                jsonb_set(support_metadata,'{targetOutcome}',to_jsonb($3::text),TRUE),
                '{targetOutcomeObservedAt}',to_jsonb(NOW()::text),TRUE
              )
              ELSE support_metadata
            END,
            updated_at=NOW()
      WHERE support_node_id=$1 OR target_node_id=$1`,
    [nodeID, isCompleted ? 'completed' : 'dismissed', isCompleted ? 'completed' : 'skipped'],
  );
}
