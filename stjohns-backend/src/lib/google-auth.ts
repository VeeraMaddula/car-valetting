import { JWT } from 'google-auth-library';
import type { Config } from '../config.js';

// One Google service account powers Calendar and Analytics. Share the owner's calendar with its
// email, and add the same email as a Viewer on the Google Analytics property.

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const clients = new Map<string, JWT>();

/** Accepts the key file's JSON, or the same JSON base64-encoded (easier to paste into hosting dashboards). */
export function parseServiceAccount(raw: string): ServiceAccount {
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const creds = JSON.parse(json) as Partial<ServiceAccount>;
  if (!creds.client_email || !creds.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  return { client_email: creds.client_email, private_key: creds.private_key };
}

/** A cached, auto-refreshing client for the given scopes. */
export function googleClient(config: Config, scopes: string[]): JWT {
  const raw = config.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const key = `${scopes.join(' ')}|${raw.length}|${raw.slice(-24)}`;
  let client = clients.get(key);
  if (!client) {
    const creds = parseServiceAccount(raw);
    client = new JWT({ email: creds.client_email, key: creds.private_key, scopes });
    clients.set(key, client);
  }
  return client;
}

/** HTTP status from a google-auth-library / gaxios error, if any. */
export function googleErrorStatus(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number }; code?: number | string };
  return e?.status ?? e?.response?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
}
