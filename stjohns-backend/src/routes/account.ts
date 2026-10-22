import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { bookingDetail, cancelByCustomer, claimBooking, findUserBooking, listUserBookings, toCustomerView } from '../domain/bookings.js';
import { deleteMyAccount, exportMyData, getProfile, updateProfile } from '../domain/profile.js';
import { todayInZone } from '../lib/time.js';
import { optionalTrimmed, parse } from '../lib/validate.js';
import { clearSessionCookie, requireUser } from '../plugins/auth.js';

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

  // ---------- My profile ----------

  app.get('/me/profile', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { profile: await getProfile(deps, req.user!.id) };
  });

  app.put('/me/profile', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => ({
    profile: await updateProfile(deps, req.user!, req.body),
  }));

  /** GDPR right of access: a copy of everything held about this account, downloaded as a JSON file. */
  app.get('/me/data', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Disposition', `attachment; filename="st-johns-park-my-data-${todayInZone(deps.config.TIMEZONE)}.json"`);
    return exportMyData(deps, req.user!);
  });

  /** GDPR right to erasure: delete the account (password required), then sign out. */
  app.post('/me/delete', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const result = await deleteMyAccount(deps, req.user!, req.body);
    clearSessionCookie(reply, deps.config);
    return { ok: true, ...result };
  });
}
