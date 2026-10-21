// Vitest setup: take TEST_DATABASE_URL (a Neon dev branch) from .env so `npm test` needs no extra typing.
// Only that one value is copied; the production DATABASE_URL never reaches the tests, just its host name
// so test-db.ts can refuse to run against the production branch.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

if (existsSync('.env')) {
  const env = parseEnv(readFileSync('.env', 'utf8'));
  if (!process.env.TEST_DATABASE_URL && env.TEST_DATABASE_URL) process.env.TEST_DATABASE_URL = env.TEST_DATABASE_URL;
  if (env.DATABASE_URL) {
    try {
      process.env.PRODUCTION_DATABASE_HOST = new URL(env.DATABASE_URL).hostname;
    } catch {
      // Not a URL; nothing to compare against.
    }
  }
}
