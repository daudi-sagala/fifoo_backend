import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { pool } from '../src/db.js';
import { pseudonymousUserKey } from '../src/services/learningData.js';

const DATASETS = Object.freeze({
  choice: 'learning_candidate_choice_examples_v1',
  completion: 'learning_completion_examples_v1',
  routes: 'learning_route_choice_examples_v1',
});

const dataset = String(process.env.LEARNING_DATASET ?? 'completion').trim();
const view = DATASETS[dataset];
if (!view) throw new Error(`LEARNING_DATASET must be one of: ${Object.keys(DATASETS).join(', ')}`);

const secret = process.env.LEARNING_EXPORT_HMAC_KEY;
if (!secret) throw new Error('LEARNING_EXPORT_HMAC_KEY is required so raw user IDs are never exported.');

const outputPath = process.env.LEARNING_EXPORT_PATH ?? `./learning-${dataset}.jsonl`;
const startDate = process.env.LEARNING_START_DATE ?? null;
const endDate = process.env.LEARNING_END_DATE ?? null;
const limit = Math.max(1, Math.min(5_000_000, Number(process.env.LEARNING_LIMIT ?? 1_000_000)));

const clauses = [];
const parameters = [];
if (startDate) {
  parameters.push(startDate);
  clauses.push(`map_date >= $${parameters.length}::date`);
}
if (endDate) {
  parameters.push(endDate);
  clauses.push(`map_date <= $${parameters.length}::date`);
}
parameters.push(limit);
const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

const client = await pool.connect();
const output = createWriteStream(outputPath, { encoding: 'utf8' });
try {
  const result = await client.query(
    `SELECT * FROM ${view} ${where} ORDER BY decision_at,routing_decision_event_id LIMIT $${parameters.length}`,
    parameters,
  );
  for (const row of result.rows) {
    const { user_id: rawUserID, ...rest } = row;
    const record = {
      ...rest,
      userKey: pseudonymousUserKey(rawUserID, secret),
    };
    if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, 'drain');
  }
  output.end();
  await once(output, 'finish');
  console.log(JSON.stringify({ success: true, dataset, rows: result.rowCount, outputPath }, null, 2));
} finally {
  client.release();
  await pool.end();
}
