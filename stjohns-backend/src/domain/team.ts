// Admin › Settings › Team access. "Bookings only" is the 'staff' role; "Full access" is 'admin'.
// Everyone invited gets an email link (valid 7 days). Access is granted only through that link, because opening
// it proves they control the inbox (email addresses aren't verified at registration): new people create their
// login with the invited address; people with an account sign in to it and accept.
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { withTx } from '../db/pool.js';
import { enqueue } from '../jobs/queue.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { isUuid, parse } from '../lib/validate.js';
import { forgetUserSessions, type SessionUser } from './users.js';

const INVITE_DAYS = 7;
type Access = 'bookings' | 'full';
const roleFor = (access: Access) => (access === 'full' ? ('admin' as const) : ('staff' as const));
const accessOf = (role: string): Access => (role === 'admin' ? 'full' : 'bookings');

export async function listTeam(deps: Deps, me: SessionUser) {
  const [members, invites] = await Promise.all([
    deps.db.query<{ id: string; full_name: string; email: string; username: string; role: string; created_at: Date }>(
      "SELECT id, full_name, email, username, role, created_at FROM users WHERE role IN ('staff', 'admin') ORDER BY role = 'admin' DESC, created_at",
    ),
    deps.db.query<{ id: string; email: string; role: string; created_at: Date; expires_at: Date }>(
      'SELECT id, email, role, created_at, expires_at FROM team_invites WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC',
    ),
  ]);
  return {
    members: members.rows.map((m) => ({
      id: m.id,
      name: m.full_name,
      email: m.email,
      username: m.username,
      access: accessOf(m.role),
      isYou: m.id === me.id,
      since: m.created_at.toISOString(),
    })),
    invites: invites.rows.map((i) => ({ id: i.id, email: i.email, access: accessOf(i.role), sentAt: i.created_at.toISOString(), expiresAt: i.expires_at.toISOString() })),
  };
}

export const inviteSchema = z.object({
  email: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.email('Enter a valid email address').max(254)),
  access: z.enum(['bookings', 'full'], { error: 'Choose the access level' }),
});

export async function inviteMember(deps: Deps, raw: unknown, me: SessionUser): Promise<{ status: 'invited' }> {
  const input = parse(inviteSchema, raw);
  await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ role: string }>('SELECT role FROM users WHERE email = $1', [input.email]);
    if (rows[0] && rows[0].role !== 'customer') {
      throw new AppError('CONFLICT', 'That person already has access.', { email: 'That person already has access' });
    }
    // A fresh invite replaces any earlier one for the same address, so only the newest link works.
    await c.query('DELETE FROM team_invites WHERE email = $1 AND accepted_at IS NULL', [input.email]);
    const token = randomToken(32);
    const invite = await c.query<{ id: string }>(
      'INSERT INTO team_invites (token_hash, email, role, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [sha256(token), input.email, roleFor(input.access), me.id, new Date(Date.now() + INVITE_DAYS * 86_400_000)],
    );
    await enqueue(c, [{ kind: 'team.invite', payload: { inviteId: invite.rows[0].id, token } }]);
  });
  deps.wakeWorker();
  return { status: 'invited' };
}

export const acceptInviteSchema = z.object({
  token: z.string({ error: 'Invite link is invalid' }).min(20, 'Invite link is invalid').max(100, 'Invite link is invalid'),
});

/** A signed-in customer opens the invite link sent to their own email address. */
export async function acceptInvite(deps: Deps, me: SessionUser, raw: unknown): Promise<SessionUser> {
  const { token } = parse(acceptInviteSchema, raw);
  const role = await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ id: string; email: string; role: 'staff' | 'admin' }>(
      'SELECT id, email, role FROM team_invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE',
      [sha256(token)],
    );
    const invite = rows[0];
    if (!invite) throw new AppError('VALIDATION_FAILED', 'This invite link is invalid or has expired. Ask for a new one.', { token: 'Expired' });
    // Use the account as it is now, not the (up to 30 s old) session copy, and lock it so a concurrent role change
    // waits. Lock order (invite, then this user) can't cycle with removeMember (all admins, then the target).
    const current = await c.query<{ email: string; role: SessionUser['role'] }>('SELECT email, role FROM users WHERE id = $1 FOR UPDATE', [me.id]);
    const account = current.rows[0];
    if (!account) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
    if (invite.email !== account.email.toLowerCase()) {
      throw new AppError('FORBIDDEN', `This invite was sent to ${invite.email}. Sign in with that account to accept it.`);
    }
    // Never lower an existing full-access login to bookings-only by accepting an older invite.
    const newRole = account.role === 'admin' ? 'admin' : invite.role;
    await c.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [me.id, newRole]);
    await c.query('UPDATE team_invites SET accepted_at = now() WHERE id = $1', [invite.id]);
    return newRole;
  });
  forgetUserSessions(me.id);
  return { ...me, role };
}

/** Take away dashboard access (the account stays, as a customer account). The owner can't remove themselves or the last full-access login. */
export async function removeMember(deps: Deps, userId: string, me: SessionUser): Promise<void> {
  if (!isUuid(userId)) throw new AppError('NOT_FOUND', 'Team member not found.');
  if (userId === me.id) throw new AppError('FORBIDDEN', "You can't remove your own access.");
  await withTx(deps.db, async (c) => {
    // Lock the full-access logins in a fixed order first, so two owners removing each other can't deadlock.
    const admins = await c.query<{ id: string }>("SELECT id FROM users WHERE role = 'admin' ORDER BY id FOR UPDATE");
    const { rows } = await c.query<{ role: string }>("SELECT role FROM users WHERE id = $1 AND role IN ('staff', 'admin') FOR UPDATE", [userId]);
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Team member not found.');
    if (rows[0].role === 'admin' && admins.rows.length <= 1) throw new AppError('CONFLICT', 'Keep at least one login with full access.');
    await c.query("UPDATE users SET role = 'customer', updated_at = now() WHERE id = $1", [userId]);
    await c.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    // An open invite for their address must not be able to give the access straight back.
    await c.query('DELETE FROM team_invites WHERE accepted_at IS NULL AND email = (SELECT email FROM users WHERE id = $1)', [userId]);
  });
  forgetUserSessions(userId);
}

export async function revokeInvite(deps: Deps, id: string): Promise<void> {
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Invite not found.');
  const res = await deps.db.query('DELETE FROM team_invites WHERE id = $1 AND accepted_at IS NULL', [id]);
  if (!res.rowCount) throw new AppError('NOT_FOUND', 'Invite not found.');
}
