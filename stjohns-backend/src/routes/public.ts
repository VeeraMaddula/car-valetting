import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { getAvailability, MAX_RANGE_DAYS } from '../domain/availability.js';
import { checkDiscount } from '../domain/discounts.js';
import { quoteService, SIZE_LABELS, toEur, VEHICLE_SIZES, type VehicleSize } from '../domain/pricing.js';
import {
  bookingIcsEvent,
  cancelByCustomer,
  createBooking,
  fetchBookingByReference,
  findByReferenceAndPhone,
  idempotencyKeySchema,
  toCustomerView,
  trackBooking,
  trackSchema,
} from '../domain/bookings.js';
import { safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { buildIcs } from '../lib/ics.js';
import { formatReference, normalizeReference } from '../lib/reference.js';
import { addDays, diffDays, todayInZone } from '../lib/time.js';
import { isoDate, optionalTrimmed, parse } from '../lib/validate.js';

const availabilityQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const cancelSchema = trackSchema.extend({ reason: optionalTrimmed(500, 'Reason') });
const perMinute = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

export async function publicRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  const { config } = deps;

  app.get('/health', async (_req, reply) => {
    const started = performance.now();
    await deps.db.query('SELECT 1');
    reply.header('Cache-Control', 'no-store');
    return { ok: true, dbMs: Math.round((performance.now() - started) * 10) / 10 };
  });

  /** Everything the booking page needs to render before asking for availability. */
  app.get('/config', async (_req, reply) => {
    const { services, periods, addons, site } = await deps.settings.get();
    const today = todayInZone(config.TIMEZONE);
    const bySize = site.pricing.bySize;
    const priced = (s: (typeof services)[number], size: VehicleSize | null) => {
      const q = quoteService(s, size, bySize, today);
      return { priceEur: toEur(q.listCents), salePriceEur: q.onSale ? toEur(q.priceCents) : null };
    };
    // Short cache so changes in the dashboard (pausing bookings, a new sale) reach customers within a minute.
    reply.header('Cache-Control', 'public, max-age=60');
    return {
      business: {
        name: config.BUSINESS_NAME,
        phone: config.BUSINESS_PHONE,
        address: config.BUSINESS_ADDRESS,
        email: site.business.publicEmail,
        openingHours: site.business.openingHours,
      },
      timezone: config.TIMEZONE,
      analytics: { measurementId: config.GA4_MEASUREMENT_ID ?? null },
      booking: {
        maxDaysAhead: config.BOOKING_MAX_DAYS_AHEAD,
        minLeadMinutes: config.BOOKING_MIN_LEAD_MINUTES,
        cancelCutoffHours: config.CANCEL_CUTOFF_HOURS,
        depositAmountEur: config.DEPOSIT_AMOUNT_EUR,
        onlineDeposit: config.stripeEnabled,
        paused: site.booking.paused,
        pausedMessage: site.booking.paused ? site.booking.pausedMessage : null,
        pricesBySize: bySize,
        vehicleSizes: bySize ? VEHICLE_SIZES.map((code) => ({ code, label: SIZE_LABELS[code] })) : [],
      },
      services: services
        .filter((s) => s.active)
        .map((s) => {
          const base = priced(s, null);
          return {
            code: s.code,
            name: s.name,
            durationLabel: s.durationLabel,
            description: s.description,
            featured: s.featured,
            priceEur: base.priceEur,
            priceFrom: s.priceFrom,
            salePriceEur: base.salePriceEur,
            saleEndsOn: base.salePriceEur !== null ? s.saleEndsOn : null,
            prices: bySize ? Object.fromEntries(VEHICLE_SIZES.map((size) => [size, priced(s, size)])) : null,
          };
        }),
      addons: addons.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name, priceEur: a.priceCents / 100 })),
      periods: periods
        .filter((p) => p.active)
        .map((p) => ({ code: p.code, label: p.label, startTime: p.startTime?.slice(0, 5) ?? null, endTime: p.endTime?.slice(0, 5) ?? null, daysOfWeek: p.daysOfWeek })),
    };
  });

  /** Day-by-day slot availability. Defaults to the next 14 days. */
  app.get('/availability', perMinute(120), async (req, reply) => {
    const q = parse(availabilityQuery, req.query);
    const today = todayInZone(config.TIMEZONE);
    const from = q.from ?? today;
    const to = q.to ?? addDays(from, 13);
    if (to < from) throw new AppError('VALIDATION_FAILED', '"to" must be on or after "from".', { to: 'Must be on or after from' });
    if (diffDays(from, to) + 1 > MAX_RANGE_DAYS) {
      throw new AppError('VALIDATION_FAILED', `Ask for at most ${MAX_RANGE_DAYS} days at a time.`, { to: 'Range too long' });
    }
    if (diffDays(today, from) < -31) throw new AppError('VALIDATION_FAILED', 'That range is too far in the past.', { from: 'Too far back' });
    reply.header('Cache-Control', 'no-store');
    return getAvailability(deps, from, to);
  });

  /** Book as a guest, or as the signed-in user. Send an Idempotency-Key header so retries never double-book. */
  app.post('/bookings', perMinute(10), async (req, reply) => {
    const idempotencyKey = parse(idempotencyKeySchema, req.headers['idempotency-key']);
    const { booking, created } = await createBooking(deps, req.body, {
      userId: req.user?.id ?? null,
      userEmail: req.user?.email ?? null,
      idempotencyKey,
    });
    reply.status(created ? 201 : 200);
    return { booking: toCustomerView(config, booking) };
  });

  /** "Apply code" on the booking page: checks a discount code and returns the new total, without using it up. */
  app.post('/discounts/check', perMinute(20), async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return checkDiscount(deps, req.body, req.user?.id ?? null);
  });

  /** Track any booking (guest or account) with its reference + the phone number used to book. */
  app.post('/bookings/track', perMinute(20), async (req) => ({ booking: await trackBooking(deps, req.body) }));

  app.post('/bookings/track/cancel', perMinute(10), async (req) => {
    const input = parse(cancelSchema, req.body);
    const booking = await findByReferenceAndPhone(deps.db, input.reference, input.phone);
    const updated = await cancelByCustomer(deps, booking.id, input.reason, booking.userId ? 'customer' : 'guest');
    return { booking: toCustomerView(config, updated, { maskPhone: true }) };
  });

  /** "Add to calendar" link used in emails and SMS; opens straight into Apple Calendar on iPhone. */
  app.get('/bookings/:reference/calendar.ics', perMinute(60), async (req, reply) => {
    const { reference } = req.params as { reference: string };
    const { t } = req.query as { t?: string };
    const ref = normalizeReference(reference);
    const booking = ref ? await fetchBookingByReference(deps.db, ref) : null;
    if (!booking || typeof t !== 'string' || !safeEqual(t, booking.calendarToken)) {
      throw new AppError('NOT_FOUND', 'Calendar file not found.');
    }
    const ics = buildIcs({ name: config.BUSINESS_NAME, events: [bookingIcsEvent(config, booking, 'customer')] });
    reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', `inline; filename="valet-${formatReference(booking.reference)}.ics"`)
      .header('Cache-Control', 'private, no-cache');
    return ics;
  });
}
