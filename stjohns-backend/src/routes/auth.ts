import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { acceptInvite } from '../domain/team.js';
import { createSession, destroySession, login, publicUser, register, requestPasswordReset, resetPassword } from '../domain/users.js';
import { clearSessionCookie, requireUser, setSessionCookie } from '../plugins/auth.js';

const limit = (max: number, minutes: number) => ({ config: { rateLimit: { max, timeWindow: `${minutes} minutes` } } });

export async function authRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  const { config, db } = deps;

  app.post('/auth/register', limit(10, 10), async (req, reply) => {
    const user = await register(deps, req.body);
    setSessionCookie(reply, config, await createSession(db, user.id, req.headers['user-agent'], config.SESSION_TTL_DAYS));
    reply.status(201);
    return { user: publicUser(user) };
  });

  app.post('/auth/login', limit(10, 5), async (req, reply) => {
    const user = await login(deps, req.body);
    setSessionCookie(reply, config, await createSession(db, user.id, req.headers['user-agent'], config.SESSION_TTL_DAYS));
    return { user: publicUser(user) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionToken) await destroySession(db, req.sessionToken);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  /** Returns { user: null } when signed out, so the site can call it on every page without errors. */
  app.get('/auth/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { user: req.user ? publicUser(req.user) : null };
  });

  app.post('/auth/password/forgot', limit(5, 15), async (req, reply) => {
    await requestPasswordReset(deps, req.body);
    reply.status(202);
    return { ok: true, message: "If an account exists for that email, we've sent a reset link." };
  });

  /** A signed-in account accepts a team invite that was emailed to its own address. */
  app.post('/auth/invites/accept', limit(10, 10), async (req) => ({ user: publicUser(await acceptInvite(deps, requireUser(req), req.body)) }));

  app.post('/auth/password/reset', limit(10, 15), async (req, reply) => {
    await resetPassword(deps, req.body);
    clearSessionCookie(reply, config);
    return { ok: true };
  });
}
