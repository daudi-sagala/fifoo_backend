import { startObservability } from './observability.js';
import { config } from './config.js';

await startObservability();

if (config.runMigrationsOnStart) {
  const { runMigrations } = await import('./services/migrations.js');
  await runMigrations();
}

await import('./server.js');
