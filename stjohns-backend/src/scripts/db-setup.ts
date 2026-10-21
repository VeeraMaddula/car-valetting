// Prepare the database named in DATABASE_URL: create it if missing (where the user is allowed to),
// apply migrations, and report the server, TLS mode and round-trip time from this machine.
// Works on plain PostgreSQL (Neon, Supabase, RDS, local) and on CockroachDB.
// Usage: npm run db:setup     (production build: node dist/scripts/db-setup.js)
import pg from 'pg';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';

const config = loadConfig();
const target = new URL(config.DATABASE_URL);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, '')) || 'postgres';
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(target.hostname);
const sslmode = target.searchParams.get('sslmode') ?? '(not set)';

function explain(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e.code === 'ENOTFOUND') return `Host "${target.hostname}" not found. Copy the connection string again from your database provider's console.`;
  if (e.code === '28P01' || e.code === '28000') return 'Username or password rejected. Check the role/password in the console (you can reset it there).';
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED') return `Could not reach ${target.hostname}:${target.port || 5432}. Check the host/port and that outbound connections are allowed.`;
  if (/certificate|self[- ]signed|SELF_SIGNED/i.test(e.message ?? '')) return `TLS certificate problem: ${e.message}. Use the provider's pooled connection string with sslmode=verify-full.`;
  if (e.code === '3D000') return `Database "${dbName}" does not exist and this role may not create it. Create it in the console, then run again.`;
  if (e.code === '42501') return 'This role lacks permission. On Neon/Supabase use the owner role from the console connection string.';
  return e.message ?? String(err);
}

if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) {
  console.error(`Database name "${dbName}" should be lower-case letters, digits or _ (e.g. stjohns).`);
  process.exit(1);
}

/** Create the database if it is missing. Tries the maintenance DBs in turn; silently skips if not permitted. */
async function ensureDatabase(): Promise<'exists' | 'created' | 'skipped'> {
  for (const maintenance of ['postgres', 'defaultdb', 'neondb']) {
    if (maintenance === dbName) return 'exists';
    const adminUrl = new URL(target);
    adminUrl.pathname = `/${maintenance}`;
    const admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 20_000 });
    try {
      await admin.connect();
    } catch {
      continue; // that maintenance DB doesn't exist on this provider; try the next
    }
    try {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      if (rowCount) return 'exists';
      await admin.query(`CREATE DATABASE "${dbName}"`);
      return 'created';
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === '42501') return 'skipped'; // not allowed to create; the target may still exist
      throw err;
    } finally {
      await admin.end().catch(() => undefined);
    }
  }
  return 'skipped';
}

try {
  const outcome = await ensureDatabase();
  if (outcome === 'created') console.log(`Created database ${dbName}.`);

  const pool = createPool(config);
  console.log(`Migrating ${dbName} on ${target.hostname}…`);
  await migrate(pool, (msg) => console.log(`  ${msg}`));

  const version = String((await pool.query('SELECT version() AS v')).rows[0].v).split(' on ')[0].split(' (')[0];
  const tables = Number((await pool.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n);
  const services = (await pool.query('SELECT code, name, price_cents FROM services WHERE active ORDER BY sort')).rows as { code: string; name: string; price_cents: number | null }[];
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    await pool.query('SELECT 1');
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log('');
  console.log(`  Database   ${dbName} (${tables} tables)`);
  console.log(`  Server     ${version}`);
  console.log(`  Host       ${target.hostname}`);
  console.log(`  TLS        sslmode=${sslmode}`);
  console.log(`  Services   ${services.map((s) => `${s.name}${s.price_cents === null ? '' : ` €${s.price_cents / 100}`}`).join(' · ')}`);
  console.log(`  Round trip ${times[4].toFixed(1)} ms median from this machine (host the API in the same region as the database)`);
  if (!isLocal && sslmode !== 'verify-full') console.warn('\n  WARNING: use sslmode=verify-full for a cloud database.');
  await pool.end();
  console.log('\nDatabase ready.');
} catch (err) {
  console.error(`\nDatabase setup failed: ${explain(err)}`);
  process.exitCode = 1;
}
