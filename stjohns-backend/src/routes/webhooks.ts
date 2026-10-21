import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { applyStripeEvent } from '../domain/deposits.js';
import { verifyWebhook } from '../payments/stripe.js';

/**
 * Stripe calls this after a deposit is paid, a link expires, or a charge is refunded.
 * The body must stay raw for the signature check, so this plugin registers its own JSON parser that
 * keeps the bytes. Stripe retries for 3 days on anything but a 2xx, so we answer 200 even for events
 * we ignore and 400 only for bad signatures (those will never become valid).
 */
export async function webhookRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/stripe', { bodyLimit: 512 * 1024, config: { rateLimit: false } }, async (req, reply) => {
    if (!deps.config.stripeEnabled) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    const signature = req.headers['stripe-signature'];
    let event;
    try {
      event = await verifyWebhook(deps.config, req.body as Buffer, Array.isArray(signature) ? signature[0] : signature);
    } catch (err) {
      req.log.warn({ err }, 'stripe webhook rejected');
      return reply.status(400).send({ error: { code: 'BAD_SIGNATURE', message: 'Webhook signature verification failed.' } });
    }
    const outcome = await applyStripeEvent(deps, event);
    req.log.info({ eventId: event.id, type: event.type, outcome }, 'stripe webhook');
    reply.header('Cache-Control', 'no-store');
    return { received: true, outcome };
  });
}
