import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { bookingDetail, cancelByCustomer, claimBooking, findUserBooking, listUserBookings, toCustomerView } from '../domain/bookings.js';
import { optionalTrimmed, parse } from '../lib/validate.js';
import { requireUser } from '../plugins/auth.js';

const cancelBody = z.object({ reason: optionalTrimmed(500, 'Reason') }).default({ reason: null });

/** Signed-in customer's own bookings. Every route here requires a session. */
export async function accountRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  app.addHook('preHandler', async (req) => {
    requireUser(req);
  });

  app.get('/me/bookings', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { bookings: await listUserBookings(deps, req.user!.id) };
  });

  app.get('/me/bookings/:reference', async (req, reply) => {
    const { reference } = req.params as { reference: string };
    reply.header('Cache-Control', 'no-store');
    return { booking: await bookingDetail(deps, await findUserBooking(deps, req.user!.id, reference)) };
  });

  app.post('/me/bookings/:reference/cancel', async (req) => {
    const { reference } = req.params as { reference: string };
    const { reason } = parse(cancelBody, req.body ?? {});
    const booking = await findUserBooking(deps, req.user!.id, reference);
    return { booking: toCustomerView(deps.config, await cancelByCustomer(deps, booking.id, reason, 'customer')) };
  });

  /** Add a booking made as a guest to this account (proven by reference + phone). */
  app.post('/me/bookings/claim', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => ({
    booking: await claimBooking(deps, req.user!.id, req.body),
  }));
}
