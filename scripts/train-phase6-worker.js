import { pool } from '../src/db.js';
import { trainAndPersistCompletionHierarchy } from '../src/services/modelTraining.js';

async function execute(options) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await trainAndPersistCompletionHierarchy(client, options ?? {});
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

process.on('message', async (message) => {
  if (message?.type !== 'train') return;
  try {
    const result = await execute(message.options);
    process.send?.({ type: 'result', result });
  } catch (error) {
    process.send?.({ type: 'error', message: error?.message ?? String(error) });
  } finally {
    await pool.end();
    process.exit(0);
  }
});
