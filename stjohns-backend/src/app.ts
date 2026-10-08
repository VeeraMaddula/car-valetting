import { randomUUID } from 'node:crypto';
import { constants as zlib } from 'node:zlib';
import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';
import type { Deps } from './deps.js';
import { AppError } from './lib/errors.js';
import { registerAuth } from './plugins/auth.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { publicRoutes } from './routes/public.js';

function loggerOptions(config: Config): FastifyServerOptions['logger'] {
  const base = {
    level: config.LOG_LEVEL,
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '[redacted]' },
  };
  if (config.isProduction) return base;
  return { ...base, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } };
}

export async function buildApp(deps: Deps, opts: { logger?: FastifyServerOptions['logger']; rateLimit?: boolean } = {}) {
  const { config } = deps;
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(config),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 16 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['Server-Timing'],
    // Browsers cache the preflight for a day, saving a round trip on every booking/login request.
    maxAge: 86_400,
  });
  await app.register(cookie);
  await app.register(compress, {
    threshold: 1024,
    encodings: ['br', 'gzip'],
    // Brotli's default (quality 11) is far too slow for live API responses.
    brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } },
  });
  if (opts.rateLimit !== false) {
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      errorResponseBuilder: () => new AppError('RATE_LIMITED', 'Too many requests. Please wait a moment and try again.'),
    });
  }

  registerAuth(app, deps);

  // Lets the browser's network panel show server time for each request.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Server-Timing', `app;dur=${reply.elapsedTime.toFixed(1)}`);
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) reply.header('Timing-Allow-Origin', origin);
    return payload;
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const message =
        status === 413 ? 'Request too large.' : status === 415 ? 'Send JSON with Content-Type: application/json.' : 'The request could not be understood.';
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: `Something went wrong on our side. Please try again, or call us on ${config.BUSINESS_PHONE}.` },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });

  await app.register(
    async (api) => {
      await api.register(publicRoutes, { deps });
      await api.register(authRoutes, { deps });
      await api.register(accountRoutes, { deps });
      await api.register(adminRoutes, { deps });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
