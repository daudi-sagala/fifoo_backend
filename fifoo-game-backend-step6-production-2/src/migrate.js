import { pool } from './db.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './services/migrations.js';

try {
  await runMigrations();
  logger.info('database migrations complete');
} catch (error) {
  logger.error('database migration failed', { error });
  process.exitCode = 1;
} finally {
  await pool.end();
}
