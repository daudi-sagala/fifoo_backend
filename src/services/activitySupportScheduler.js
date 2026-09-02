import { config } from '../config.js';
import { pool } from '../db.js';
import { IN } from '../events.js';
import { logger } from '../lib/logger.js';
import { dayRoom, userRoom } from './dayMaps.js';
import { refreshActivitySupportPlanForUser } from './activitySupportPlanner.js';

let startupHandle = null;
let intervalHandle = null;
let running = false;

async function usersWithTimeZones() {
  const result = await pool.query(
    `SELECT u.user_id,
            COALESCE(
              (SELECT dm.timezone
                 FROM day_maps dm
                WHERE dm.user_id=u.user_id
                ORDER BY dm.map_date DESC
                LIMIT 1),
              $1
            ) AS timezone
       FROM users u
      ORDER BY u.user_id`,
    [config.defaultTimeZone],
  );
  return result.rows;
}

function broadcastResult(io, userID, result) {
  for (const change of result.changes ?? []) {
    const room = dayRoom(userID, change.mapDate);
    for (const node of change.upsertedNodes ?? []) {
      io.to(room).emit(IN.nodeUpserted, { node, revision: change.revision });
    }
    for (const nodeID of change.deletedNodeIDs ?? []) {
      io.to(room).emit(IN.nodeDeleted, { nodeID: { rawValue: nodeID }, revision: change.revision });
    }
    if (change.dayPlanState) io.to(room).emit(IN.dayPlanState, change.dayPlanState);
  }
  if (result.state) io.to(userRoom(userID)).emit(IN.supportPlanState, result.state);
}

export async function runActivitySupportSchedulerTick(io, now = new Date()) {
  if (running) return { skipped: true, reason: 'tick_already_running' };
  running = true;
  let processed = 0;
  let changedUsers = 0;
  let failures = 0;
  const startedAt = Date.now();
  try {
    const users = await usersWithTimeZones();
    for (const user of users) {
      try {
        const result = await refreshActivitySupportPlanForUser({
          userID: user.user_id,
          timeZoneIdentifier: user.timezone,
          now,
        });
        processed += 1;
        if (result.changes?.length) changedUsers += 1;
        if (io) broadcastResult(io, user.user_id, result);
      } catch (error) {
        failures += 1;
        logger.error('activity support scheduler user failed', {
          userID: user.user_id,
          error,
        });
      }
    }
    const summary = {
      users: users.length,
      processed,
      changedUsers,
      failures,
      durationMs: Date.now() - startedAt,
    };
    logger.info('activity support scheduler tick complete', summary);
    return summary;
  } finally {
    running = false;
  }
}

export function startActivitySupportScheduler(io) {
  if (!config.activitySupportPlannerEnabled
      || !config.activitySupportSchedulerEnabled
      || startupHandle
      || intervalHandle) return false;

  const run = () => runActivitySupportSchedulerTick(io).catch((error) => {
    logger.error('activity support scheduler tick crashed', { error });
  });
  startupHandle = setTimeout(() => {
    startupHandle = null;
    run();
    intervalHandle = setInterval(run, config.activitySupportSchedulerIntervalMs);
    intervalHandle.unref?.();
  }, config.activitySupportSchedulerStartupDelayMs);
  startupHandle.unref?.();

  logger.info('activity support scheduler started', {
    intervalMs: config.activitySupportSchedulerIntervalMs,
    startupDelayMs: config.activitySupportSchedulerStartupDelayMs,
    horizonHours: config.activitySupportHorizonHours,
  });
  return true;
}

export function stopActivitySupportScheduler() {
  if (startupHandle) clearTimeout(startupHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startupHandle = null;
  intervalHandle = null;
  running = false;
}
