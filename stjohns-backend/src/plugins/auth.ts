import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Deps } from '../deps.js';
import { SESSION_COOKIE, sessionUser, type SessionUser } from '../domain/users.js';
import { AppError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionToken: string | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Attach the signed-in user (if any) and block cross-site writes. Registered at the root so it covers every route. */
export function registerAuth(app: FastifyInstance, deps: Deps): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);
  app.addHook('onRequest', async (req) => {
    // CSRF defence on top of SameSite cookies: browsers always send Origin on cross-site writes.
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin && !deps.config.allowedOrigins.includes(origin)) {
        throw new AppError('FORBIDDEN', 'This request was blocked because it came from another website.');
      }
    }
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      req.sessionToken = token;
      req.user = await sessionUser(deps.db, token);
    }
  });
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
  return req.user;
}

/** Full access: prices, discounts, photos, customers, analytics, settings and team. */
export function requireAdmin(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (user.role === 'staff') throw new AppError('FORBIDDEN', 'Your access covers bookings only. Ask the owner for full access.');
  if (user.role !== 'admin') throw new AppError('FORBIDDEN', 'You do not have access to this page.');
  return user;
}

/** Bookings access: the owner and team members with "Bookings only". */
export function requireStaff(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (user.role !== 'admin' && user.role !== 'staff') throw new AppError('FORBIDDEN', 'You do not have access to this page.');
  return user;
}

export function setSessionCookie(reply: FastifyReply, config: Config, session: { token: string; expiresAt: Date }): void {
  reply.setCookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: config.isProduction || config.COOKIE_SAMESITE === 'none',
    sameSite: config.COOKIE_SAMESITE,
    path: '/',
    domain: config.COOKIE_DOMAIN,
    expires: session.expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    domain: config.COOKIE_DOMAIN,
    secure: config.isProduction || config.COOKIE_SAMESITE === 'none',
    sameSite: config.COOKIE_SAMESITE,
    httpOnly: true,
  });
}
