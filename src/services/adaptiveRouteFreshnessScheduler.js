import { config } from '../config.js';
import { pool } from '../db.js';
import { IN } from '../events.js';
import { logger } from '../lib/logger.js';
import { dayRoom } from './dayMaps.js';
import { refreshAdaptiveRouteForUser } from './adaptiveRouteFreshness.js';

let startupHandle = null;
let intervalHandle = null;
let running = false;

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
  const hour = Number(values.hour) % 24;
  return hour * 3600 + Number(values.minute) * 60 + Number(values.second);
}

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
  if (!io || !result?.rerouted || !result.dayPlanState) return;
  io.to(dayRoom(userID, result.mapDate)).emit(IN.dayPlanState, result.dayPlanState);
}

export async function runAdaptiveRouteFreshnessSchedulerTick(io, now = new Date()) {
  if (running) return { skipped: true, reason: 'tick_already_running' };
  running = true;
  const startedAt = Date.now();
  let evaluated = 0;
  let rerouted = 0;
  let noops = 0;
  let failures = 0;
  const triggerCounts = {};

  try {
    const users = await usersWithTimeZones();
    for (const user of users) {
      try {
        const mapDate = localDateString(user.timezone, now);
        const nowSecond = localTimeSeconds(user.timezone, now);
        const result = await refreshAdaptiveRouteForUser({
          userID: user.user_id,
          mapDate,
          timeZoneIdentifier: user.timezone,
          nowSecond,
          now,
        });
        evaluated += 1;
        if (result.rerouted) {
          rerouted += 1;
          triggerCounts[result.reason] = (triggerCounts[result.reason] ?? 0) + 1;
          broadcastResult(io, user.user_id, result);
          logger.info('adaptive route freshness rerouted user', {
            userID: user.user_id,
            mapDate,
            decisionSecond: result.decisionSecond,
            trigger: result.reason,
            revision: result.revision,
            planRevision: result.dayPlanState?.planRevision ?? null,
          });
        } else {
          noops += 1;
          logger.debug('adaptive route freshness no-op', {
            userID: user.user_id,
            mapDate,
            decisionSecond: result.decisionSecond ?? null,
            reason: result.reason,
          });
        }
      } catch (error) {
        failures += 1;
        logger.error('adaptive route freshness user failed', {
          userID: user.user_id,
          error,
        });
      }
    }

    const summary = {
      users: users.length,
      evaluated,
      rerouted,
      noops,
      failures,
      triggerCounts,
      durationMs: Date.now() - startedAt,
    };
    logger.info('adaptive route freshness scheduler tick complete', summary);
    return summary;
  } finally {
    running = false;
  }
}

export function startAdaptiveRouteFreshnessScheduler(io) {
  if (!config.adaptiveRouteFreshnessSchedulerEnabled || startupHandle || intervalHandle) return false;

  const run = () => runAdaptiveRouteFreshnessSchedulerTick(io).catch((error) => {
    logger.error('adaptive route freshness scheduler tick crashed', { error });
  });

  startupHandle = setTimeout(() => {
    startupHandle = null;
    run();
    intervalHandle = setInterval(run, config.adaptiveRouteFreshnessSchedulerIntervalMs);
    intervalHandle.unref?.();
  }, config.adaptiveRouteFreshnessSchedulerStartupDelayMs);
  startupHandle.unref?.();

  logger.info('adaptive route freshness scheduler started', {
    intervalMs: config.adaptiveRouteFreshnessSchedulerIntervalMs,
    startupDelayMs: config.adaptiveRouteFreshnessSchedulerStartupDelayMs,
    cooldownMs: config.adaptiveRouteFreshnessCooldownMs,
    missedGraceSeconds: config.adaptiveRouteFreshnessMissedGraceSeconds,
    atRiskWindowSeconds: config.adaptiveRouteFreshnessAtRiskWindowSeconds,
    minimumExpectedDayFinish: config.adaptiveRouteFreshnessMinimumExpectedDayFinish,
  });
  return true;
}

export function stopAdaptiveRouteFreshnessScheduler() {
  if (startupHandle) clearTimeout(startupHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startupHandle = null;
  intervalHandle = null;
  running = false;
}

export const adaptiveRouteFreshnessSchedulerInternals = Object.freeze({
  localDateString,
  localTimeSeconds,
});
