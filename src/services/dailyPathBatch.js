import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { generateDailyPathForUser } from './dailyPathGenerator.js';

async function latestTimeZone(userID, fallback) {
  const result = await pool.query(
    `SELECT timezone FROM day_maps WHERE user_id=$1 ORDER BY map_date DESC LIMIT 1`,
    [userID],
  );
  return result.rows[0]?.timezone ?? fallback;
}

/**
 * Batch entry point intended for the production scheduler in Step 6.
 * Pass an explicit mapDate. Later, scheduling can group users by persisted
 * timezone and call this function when each local day begins.
 */
export async function generateDailyPathsForAllUsers({
  mapDate,
  defaultTimeZone = config.defaultTimeZone,
  force = false,
  userIDs = null,
  rules = undefined,
} = {}) {
  let users;
  if (Array.isArray(userIDs) && userIDs.length) {
    const result = await pool.query(
      `SELECT user_id,email FROM users WHERE user_id=ANY($1::uuid[]) ORDER BY joined,user_id`,
      [userIDs],
    );
    users = result.rows;
  } else {
    const result = await pool.query('SELECT user_id,email FROM users ORDER BY joined,user_id');
    users = result.rows;
  }

  const results = [];
  for (const user of users) {
    const timeZoneIdentifier = await latestTimeZone(user.user_id, defaultTimeZone);
    const generated = await withTransaction((client) => generateDailyPathForUser(client, {
      userID: user.user_id,
      mapDate,
      timeZoneIdentifier,
      force,
      ...(rules ? { rules } : {}),
    }));
    results.push({
      userID: user.user_id,
      email: user.email,
      timeZoneIdentifier,
      ...generated,
    });
  }
  return results;
}
