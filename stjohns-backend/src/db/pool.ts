import pg from 'pg';
import type { Config } from '../config.js';

// DATE → 'YYYY-MM-DD' (never a JS Date shifted by the server's time zone); INT8 → number; INT8[] → number[].
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
const INT8_ARRAY_OID = 1016 as Parameters<typeof pg.types.setTypeParser>[0];
pg.types.setTypeParser(INT8_ARRAY_OID, (v: string) =>
  v
    .replace(/[{}]/g, '')
    .split(',')
    .filter(Boolean)
    .map(Number),
);

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 5 * 60_000,
    // Cloud TLS handshakes can take a moment on a cold start.
    connectionTimeoutMillis: 10_000,
    // Recycle connections so they spread across CockroachDB nodes after scaling or upgrades.
    maxLifetimeSeconds: 30 * 60,
    query_timeout: 15_000,
    keepAlive: true,
    application_name: 'stjohns-api',
  });
  pool.on('error', (err) => {
    // An idle connection dropped (e.g. network blip); the pool replaces it on next use.
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

/** Open a few connections up front so the first requests don't pay for TLS handshakes. */
export async function warmPool(pool: pg.Pool, connections: number): Promise<void> {
  await Promise.all(Array.from({ length: connections }, () => pool.query('SELECT 1')));
}

function isRetryable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  // 40001: serialization conflict; 40P01: deadlock (PostgreSQL aborts one side, which can simply run again).
  return e?.code === '40001' || e?.code === '40P01' || /restart transaction/i.test(e?.message ?? '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run fn in a transaction (READ COMMITTED on PostgreSQL/Neon), retrying on serialization conflicts
 * (SQLSTATE 40001). Correctness relies on unique indexes and SELECT … FOR UPDATE row locks, not on the
 * isolation level. fn must only touch the database, since it may run more than once.
 */
export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>, maxAttempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isRetryable(err) && attempt < maxAttempts) {
        await sleep(Math.random() * Math.min(1000, 10 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
