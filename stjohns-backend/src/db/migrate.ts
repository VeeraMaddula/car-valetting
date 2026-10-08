import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Split a migration file into statements (one per line ending in ';'), dropping comment lines. */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Apply pending migrations in filename order. Statements run one at a time because CockroachDB
 *  does not allow schema changes after writes in the same transaction. */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = console.log): Promise<string[]> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of splitStatements(sql)) await pool.query(statement);
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    log(`applied ${file}`);
    ran.push(file);
  }
  if (ran.length === 0) log('database is up to date');
  return ran;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : '';
if (invokedPath === fileURLToPath(import.meta.url).toLowerCase()) {
  const { loadConfig } = await import('../config.js');
  const { createPool } = await import('./pool.js');
  const pool = createPool(loadConfig());
  try {
    await migrate(pool);
  } catch (err) {
    console.error('migration failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
