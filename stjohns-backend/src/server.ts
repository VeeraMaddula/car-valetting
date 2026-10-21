import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, warmPool } from './db/pool.js';
import type { Deps } from './deps.js';
import { SettingsCache } from './domain/settings.js';
import { JobWorker } from './jobs/worker.js';

const config = loadConfig();
const db = createPool(config);
const settings = new SettingsCache(db, config);
let worker: JobWorker | null = null;
const deps: Deps = { config, db, settings, wakeWorker: () => worker?.wake() };

const app = await buildApp(deps);
if (config.WORKER_ENABLED) worker = new JobWorker(deps, app.log);

// Open database connections and load settings before taking traffic, so the first visitor isn't slow.
try {
  await warmPool(db, Math.min(3, config.DB_POOL_MAX));
  await settings.get();
} catch (err) {
  app.log.error({ err }, 'Database not ready. Check DATABASE_URL and run `npm run migrate`.');
}

await app.listen({ host: config.HOST, port: config.PORT });
worker?.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await app.close();
    await worker?.stop();
    await db.end();
  } finally {
    process.exit(0);
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
