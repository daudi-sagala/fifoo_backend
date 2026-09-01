import pg from 'pg';
import { config } from './config.js';
import { logger } from './lib/logger.js';

const { Pool } = pg;

function sslConfiguration() {
  if (!config.pgSSL) return false;
  const ssl = { rejectUnauthorized: config.pgSSLRejectUnauthorized };
  if (config.pgSSLCA) ssl.ca = config.pgSSLCA.replace(/\\n/g, '\n');
  return ssl;
}

export const pool = new Pool({
  connectionString: config.databaseURL,
  ssl: sslConfiguration(),
  max: config.pgPoolMax,
  idleTimeoutMillis: config.pgIdleTimeoutMs,
  connectionTimeoutMillis: config.pgConnectionTimeoutMs,
  statement_timeout: config.pgStatementTimeoutMs,
  idle_in_transaction_session_timeout: config.pgIdleTransactionTimeoutMs,
  keepAlive: true,
  application_name: 'fifoo-game-backend',
});

pool.on('error', (error) => {
  logger.error('postgresql pool error', { error });
});

export async function withClient(work) {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

export async function withTransaction(work) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
