// Each integration test file gets its own throwaway database on the TEST_DATABASE_URL server (a Neon dev
// branch), created before its tests and dropped afterwards, so files can run in parallel and leave nothing behind.
import pg from 'pg';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Neon's pooled and direct hosts differ only by "-pooler"; compare the endpoint itself. */
const endpoint = (host: string) => host.replace('-pooler', '');

export interface TestDatabase {
  url: string;
  drop: () => Promise<void>;
}

async function run(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const production = process.env.PRODUCTION_DATABASE_HOST;
  if (production && endpoint(production) === endpoint(new URL(TEST_DATABASE_URL).hostname)) {
    throw new Error('TEST_DATABASE_URL points at the production branch. Create a Neon dev branch and use its connection string.');
  }
  const name = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await run(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return { url: url.toString(), drop: () => run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`) };
}
