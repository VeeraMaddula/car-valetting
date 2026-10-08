import type pg from 'pg';
import type { Config } from './config.js';
import type { SettingsCache } from './domain/settings.js';

/** Shared services passed to domain functions and routes. */
export interface Deps {
  config: Config;
  db: pg.Pool;
  settings: SettingsCache;
  /** Tell the background worker new jobs are waiting, so notifications go out immediately. */
  wakeWorker: () => void;
}
