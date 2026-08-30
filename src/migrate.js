import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDirectory = resolve(here, '../sql');

try {
  const files = (await readdir(sqlDirectory))
    .filter((name) => /^\d+.*\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));

  for (const file of files) {
    const sql = await readFile(resolve(sqlDirectory, file), 'utf8');
    await pool.query(sql);
    console.log(`Applied sql/${file}`);
  }
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
