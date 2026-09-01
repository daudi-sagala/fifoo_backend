import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../db.js';
import { logger } from '../lib/logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDirectory = resolve(here, '../../sql');
const MIGRATION_LOCK_KEY = 674383512;

function checksum(sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function runMigrations() {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS fifoo_schema_migrations (
      filename TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const files = (await readdir(sqlDirectory))
      .filter((name) => /^\d+.*\.sql$/i.test(name))
      .sort((a, b) => a.localeCompare(b, 'en'));

    for (const file of files) {
      const sql = await readFile(resolve(sqlDirectory, file), 'utf8');
      const sha256 = checksum(sql);
      const existing = await client.query(
        'SELECT sha256 FROM fifoo_schema_migrations WHERE filename=$1',
        [file],
      );
      if (existing.rowCount) {
        if (existing.rows[0].sha256 !== sha256) {
          throw new Error(`Applied migration sql/${file} was modified. Create a new numbered migration instead.`);
        }
        continue;
      }

      await client.query(sql);
      await client.query(
        'INSERT INTO fifoo_schema_migrations(filename,sha256) VALUES ($1,$2)',
        [file, sha256],
      );
      logger.info('database migration applied', { file: `sql/${file}` });
    }
    return true;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The migration SQL may already have committed or may not be in a transaction.
    }
    throw error;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch {
      // Connection release below is still required even if unlock fails.
    } finally {
      client.release();
    }
  }
}
