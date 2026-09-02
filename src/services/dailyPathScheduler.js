import { config } from '../config.js';
import { pool, withClient } from '../db.js';
import { logger } from '../lib/logger.js';
import { generateDailyPathForUser } from './dailyPathGenerator.js';

let intervalHandle = null;
let startupHandle = null;
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

async function usersWithGenerationState() {
  const result = await pool.query(
    `SELECT u.user_id,
            u.email,
            COALESCE(
              (SELECT dm.timezone
                 FROM day_maps dm
                WHERE dm.user_id=u.user_id
                ORDER BY dm.map_date DESC
                LIMIT 1),
              $1
            ) AS timezone,
            (SELECT dm.map_date::text
               FROM day_map_generation_runs g
               JOIN day_maps dm ON dm.day_map_id=g.day_map_id
              WHERE g.user_id=u.user_id
              ORDER BY dm.map_date DESC
              LIMIT 1) AS last_generated_map_date
       FROM users u
      ORDER BY u.joined,u.user_id`,
    [config.defaultTimeZone],
  );
  return result.rows;
}

async function generateOne(user, mapDate, currentDayTimeSeconds) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const lockKey = `fifoo-daily-path:${user.user_id}:${mapDate}`;
      const lockResult = await client.query(
        'SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS locked',
        [lockKey],
      );
      if (!lockResult.rows[0]?.locked) {
        await client.query('ROLLBACK');
        return { generated: false, reason: 'locked_by_another_instance' };
      }

      const result = await generateDailyPathForUser(client, {
        userID: user.user_id,
        mapDate,
        timeZoneIdentifier: user.timezone,
        currentDayTimeSeconds,
        predictionRuntimeMode: config.predictionRuntimeMode,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function runDailyPathSchedulerTick(now = new Date()) {
  if (running) return { skipped: true, reason: 'tick_already_running' };
  running = true;
  const startedAt = Date.now();
  let candidates = 0;
  let generatedCount = 0;
  let failureCount = 0;

  try {
    const users = await usersWithGenerationState();
    for (const user of users) {
      let mapDate;
      try {
        mapDate = localDateString(user.timezone, now);
      } catch (error) {
        failureCount += 1;
        logger.error('daily path scheduler invalid timezone', {
          userID: user.user_id,
          timeZoneIdentifier: user.timezone,
          error,
        });
        continue;
      }

      if (user.last_generated_map_date === mapDate) continue;
      candidates += 1;

      try {
        const result = await generateOne(user, mapDate, localTimeSeconds(user.timezone, now));
        if (result.generated) generatedCount += 1;
        logger.info('daily path scheduler user result', {
          userID: user.user_id,
          mapDate,
          timeZoneIdentifier: user.timezone,
          generated: result.generated,
          reason: result.reason ?? null,
          revision: result.revision ?? null,
        });
      } catch (error) {
        failureCount += 1;
        logger.error('daily path scheduler generation failed', {
          userID: user.user_id,
          mapDate,
          timeZoneIdentifier: user.timezone,
          error,
        });
      }
    }

    const summary = {
      users: users.length,
      candidates,
      generated: generatedCount,
      failures: failureCount,
      durationMs: Date.now() - startedAt,
    };
    logger.info('daily path scheduler tick complete', summary);
    return summary;
  } finally {
    running = false;
  }
}

export function startDailyPathScheduler() {
  if (!config.dailyPathSchedulerEnabled || intervalHandle || startupHandle) return false;

  const run = () => {
    runDailyPathSchedulerTick().catch((error) => {
      logger.error('daily path scheduler tick crashed', { error });
    });
  };

  startupHandle = setTimeout(() => {
    startupHandle = null;
    run();
    intervalHandle = setInterval(run, config.dailyPathSchedulerIntervalMs);
    intervalHandle.unref?.();
  }, config.dailyPathSchedulerStartupDelayMs);
  startupHandle.unref?.();

  logger.info('daily path scheduler started', {
    intervalMs: config.dailyPathSchedulerIntervalMs,
    startupDelayMs: config.dailyPathSchedulerStartupDelayMs,
  });
  return true;
}

export function stopDailyPathScheduler() {
  if (startupHandle) clearTimeout(startupHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  startupHandle = null;
  intervalHandle = null;
  running = false;
}
