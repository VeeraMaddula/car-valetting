import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { withTx, type Db, type Queryable } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError, isUniqueViolation } from '../lib/errors.js';
import { displayPhone, normalizePhone } from '../lib/phone.js';
import { parse, trimmed } from '../lib/validate.js';

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  phone: string;
  /** 'staff' manages bookings only; 'admin' has full access. */
  role: 'customer' | 'staff' | 'admin';
}

export function publicUser(u: SessionUser) {
  return { id: u.id, username: u.username, email: u.email, fullName: u.fullName, phone: displayPhone(u.phone), role: u.role };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapUser(r: any): SessionUser {
  return { id: r.id, username: r.username, email: r.email, fullName: r.full_name, phone: r.phone, role: r.role };
}

const password = z
  .string({ error: 'Password is required' })
  .min(10, 'Use at least 10 characters')
  .max(200, 'Use at most 200 characters');

const email = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254));

export const registerSchema = z
  .object({
    username: z
      .string({ error: 'Username is required' })
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9._-]{3,30}$/, 'Use 3–30 letters, numbers, dots, dashes or underscores'),
    email,
    password,
    fullName: trimmed(2, 100, 'Name'),
    phone: trimmed(6, 30, 'Phone number'),
    /** From a team invite link: the new account gets the invited access. */
    inviteToken: z.string().min(20, 'Invite link is invalid').max(100, 'Invite link is invalid').optional(),
  })
  .refine((v) => v.password.toLowerCase() !== v.username, { path: ['password'], message: 'Password must not be your username' });

export const loginSchema = z.object({
  login: z.string({ error: 'Enter your username or email' }).trim().toLowerCase().min(1, 'Enter your username or email').max(254),
  password: z.string({ error: 'Enter your password' }).min(1, 'Enter your password').max(200),
});

// argon2id with the OWASP-recommended baseline (19 MiB, 2 iterations).
const HASH_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, HASH_OPTIONS);
}

let dummyHash: Promise<string> | null = null;

export async function register(deps: Deps, raw: unknown): Promise<SessionUser> {
  const input = parse(registerSchema, raw);
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError('VALIDATION_FAILED', 'Please check the highlighted fields.', { phone: 'Enter a valid phone number' });
  const passwordHash = await hashPassword(input.password);
  try {
    return await withTx(deps.db, async (c) => {
      let role: SessionUser['role'] = 'customer';
      let inviteId: string | null = null;
      if (input.inviteToken) {
        const { rows } = await c.query<{ id: string; email: string; role: 'staff' | 'admin' }>(
          'SELECT id, email, role FROM team_invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE',
          [sha256(input.inviteToken)],
        );
        const invite = rows[0];
        if (!invite) throw new AppError('VALIDATION_FAILED', 'This invite link is invalid or has expired. Ask for a new one.', { inviteToken: 'Expired' });
        if (invite.email !== input.email) {
          throw new AppError('VALIDATION_FAILED', 'Use the email address the invite was sent to.', { email: 'Use the invited email address' });
        }
        role = invite.role;
        inviteId = invite.id;
      }
      const { rows } = await c.query(
        `INSERT INTO users (username, email, full_name, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, username, email, full_name, phone, role`,
        [input.username, input.email, input.fullName, phone.e164, passwordHash, role],
      );
      if (inviteId) await c.query('UPDATE team_invites SET accepted_at = now() WHERE id = $1', [inviteId]);
      return mapUser(rows[0]);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_username_key')) {
      throw new AppError('CONFLICT', 'That username is taken.', { username: 'That username is taken' });
    }
    if (isUniqueViolation(err, 'users_email_key')) {
      throw new AppError('CONFLICT', 'An account with that email already exists. Try signing in.', { email: 'Already registered' });
    }
    throw err;
  }
}

export async function login(deps: Deps, raw: unknown): Promise<SessionUser> {
  const input = parse(loginSchema, raw);
  const { rows } = await deps.db.query(
    'SELECT id, username, email, full_name, phone, role, password_hash FROM users WHERE username = $1 OR email = $1 LIMIT 1',
    [input.login],
  );
  const row = rows[0];
  // Always run one hash verification so response time doesn't reveal whether the account exists.
  dummyHash ??= hashPassword(randomToken(16));
  const ok = await verify(row?.password_hash ?? (await dummyHash), input.password).catch(() => false);
  if (!row || !ok) throw new AppError('UNAUTHENTICATED', 'Incorrect username or password.');
  return mapUser(row);
}

// ---------- Sessions ----------

export const SESSION_COOKIE = 'sjp_session';

/**
 * Customer session lookups are cached briefly so their requests skip a database round trip. Staff and admin
 * sessions are never cached: the cache lives in one API process, so a session revoked elsewhere (another API
 * instance, or the create-admin script) must stop working for the dashboard at once, not 30 seconds later.
 */
const sessionCache = new Map<string, { user: SessionUser; expires: number }>();
const CACHE_MS = 30_000;
const CACHE_MAX = 5_000;

export async function createSession(db: Queryable, userId: string, userAgent: string | undefined, ttlDays: number) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await db.query('INSERT INTO sessions (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, $4)', [
    sha256(token),
    userId,
    userAgent?.slice(0, 300) ?? null,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function sessionUser(db: Queryable, token: string): Promise<SessionUser | null> {
  if (token.length < 20 || token.length > 100) return null;
  const key = sha256(token);
  const cached = sessionCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.user;
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.role, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [key],
  );
  const row = rows[0];
  const expiresAt = row ? new Date(row.expires_at).getTime() : NaN;
  // The session can expire while the query is in flight, so check its expiry here too.
  if (!row || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    sessionCache.delete(key);
    return null;
  }
  const user = mapUser(row);
  if (user.role !== 'customer') return user;
  if (sessionCache.size >= CACHE_MAX) sessionCache.clear();
  // Never keep a session in the cache past its own expiry.
  sessionCache.set(key, { user, expires: Math.min(Date.now() + CACHE_MS, expiresAt) });
  return user;
}

export async function destroySession(db: Queryable, token: string): Promise<void> {
  const key = sha256(token);
  sessionCache.delete(key);
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [key]);
}

/** Drop cached sessions for a user (after a role change or erasure) so the change applies on their next request. */
export function forgetUserSessions(userId: string) {
  for (const [key, entry] of sessionCache) if (entry.user.id === userId) sessionCache.delete(key);
}

/**
 * Make an existing account an admin, optionally with a new password (the create-admin script). Done in one
 * transaction that also signs the account out everywhere whenever it gains admin access or a new password, so an
 * old session can neither outlive the password change nor pick up the new access. Running API processes never
 * cache staff/admin sessions, and a cached customer session only lasts until its 30-second entry expires; after
 * that its deleted session fails to load, so it never sees the new role.
 */
export async function grantAdmin(db: Db, userId: string, passwordHash: string | null): Promise<{ revokedSessions: number }> {
  const revokedSessions = await withTx(db, async (c) => {
    const { rows } = await c.query<{ role: SessionUser['role'] }>('SELECT role FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Account not found.');
    await c.query("UPDATE users SET role = 'admin', password_hash = COALESCE($2, password_hash), updated_at = now() WHERE id = $1", [userId, passwordHash]);
    if (rows[0].role === 'admin' && !passwordHash) return 0; // already an admin, nothing changed
    const res = await c.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    return res.rowCount ?? 0;
  });
  forgetUserSessions(userId);
  return { revokedSessions };
}

// ---------- Password reset ----------

export const forgotSchema = z.object({ email });
export const resetSchema = z.object({
  token: z.string({ error: 'Reset link is invalid' }).min(20, 'Reset link is invalid').max(100),
  password,
});

/** Always succeeds from the caller's point of view, so it can't be used to discover accounts. */
export async function requestPasswordReset(deps: Deps, raw: unknown): Promise<void> {
  const input = parse(forgotSchema, raw);
  const { rows } = await deps.db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [input.email]);
  if (!rows[0]) return;
  await issuePasswordReset(deps, rows[0].id);
}

/** Email a one-hour reset link (also used by the owner's "Send password reset link"). */
export async function issuePasswordReset(deps: Deps, userId: string): Promise<void> {
  const token = randomToken(32);
  await withTx(deps.db, async (c) => {
    await c.query('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      sha256(token),
      userId,
      new Date(Date.now() + 60 * 60_000),
    ]);
    await enqueue(c, [{ kind: 'auth.password_reset', payload: { userId, token } }]);
  });
  deps.wakeWorker();
}

export async function resetPassword(deps: Deps, raw: unknown): Promise<void> {
  const input = parse(resetSchema, raw);
  const passwordHash = await hashPassword(input.password);
  const userId = await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ user_id: string }>(
      `SELECT user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(input.token)],
    );
    if (!rows[0]) throw new AppError('VALIDATION_FAILED', 'This reset link is invalid or has expired. Please request a new one.', { token: 'Expired' });
    const id = rows[0].user_id;
    await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [id, passwordHash]);
    await c.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [id]);
    await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return id;
  });
  forgetUserSessions(userId);
}
