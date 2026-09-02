import { config } from '../config.js';
import { pool, withTransaction } from '../db.js';
import { generateDailyPathForUser } from '../services/dailyPathGenerator.js';
import { dailyRulesNamed, clockSeconds, alternativeCount } from '../rules/ruleRegistry.js';

function argValue(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function localDateString(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function resolveUsers() {
  const userID = argValue('user');
  const email = argValue('email');
  if (userID) {
    const result = await pool.query('SELECT user_id,email FROM users WHERE user_id=$1', [userID]);
    return result.rows;
  }
  if (email) {
    const result = await pool.query('SELECT user_id,email FROM users WHERE LOWER(email)=LOWER($1)', [email]);
    return result.rows;
  }
  const result = await pool.query('SELECT user_id,email FROM users ORDER BY joined,user_id');
  return result.rows;
}

async function latestUserTimeZone(userID, fallback) {
  const result = await pool.query(
    `SELECT timezone FROM day_maps WHERE user_id=$1 ORDER BY map_date DESC LIMIT 1`,
    [userID],
  );
  return result.rows[0]?.timezone ?? fallback;
}

async function main() {
  if (hasFlag('help')) {
    console.log(`\nFifoo daily path generation\n\n` +
      `npm run generate:daily -- [options]\n\n` +
      `--date YYYY-MM-DD          defaults to today in DEFAULT_TIME_ZONE\n` +
      `--user <uuid>              generate one user only\n` +
      `--email <email>            generate one user only\n` +
      `--timezone <IANA>          override per-user/latest timezone\n` +
      `--force                    regenerate nodes produced by the generator\n` +
      `--rules <name>             standard | demo-aug29\n` +
      `--current-time <clock>     HH:MM[:SS] or now; splits Completed/Future\n` +
      `--alternatives <0...5>     future route alternatives (default 3)\n`);
    return;
  }

  const explicitTimeZone = argValue('timezone');
  const fallbackTimeZone = explicitTimeZone ?? config.defaultTimeZone;
  const mapDate = argValue('date') ?? localDateString(fallbackTimeZone);
  const rules = dailyRulesNamed(argValue('rules') ?? 'standard');
  const maxAlternatives = alternativeCount(argValue('alternatives'), 3);
  const users = await resolveUsers();
  if (!users.length) throw new Error('No matching users found.');

  const summaries = [];
  for (const user of users) {
    const timeZoneIdentifier = explicitTimeZone
      ?? await latestUserTimeZone(user.user_id, fallbackTimeZone);
    const result = await withTransaction((client) => generateDailyPathForUser(client, {
      userID: user.user_id,
      mapDate,
      timeZoneIdentifier,
      force: hasFlag('force'),
      rules,
      currentDayTimeSeconds: clockSeconds(argValue('current-time') ?? '', timeZoneIdentifier),
      maxAlternatives,
      predictionRuntimeMode: config.predictionRuntimeMode,
    }));
    summaries.push({
      userID: user.user_id,
      email: user.email,
      mapDate,
      timeZoneIdentifier,
      generated: result.generated,
      reason: result.reason ?? null,
      revision: result.revision,
      stops: result.generatedNodeIDs.length,
      alternatives: result.routeState?.alternativeRoutes?.length ?? null,
    });
  }

  console.table(summaries);
}

try {
  await main();
} catch (error) {
  console.error('Daily path generation failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
