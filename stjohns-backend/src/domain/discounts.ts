// Discount codes: checking a code on the booking page, redeeming it inside the booking transaction, and the
// owner's code management. Redemption locks the code's row, so "100 uses" can't be exceeded by customers
// booking at the same moment; a cancelled booking gives its use back.
import { z } from 'zod';
import type { Deps } from '../deps.js';
import type { Queryable } from '../db/pool.js';
import { AppError, isUniqueViolation } from '../lib/errors.js';
import { todayInZone } from '../lib/time.js';
import { isoDate, isUuid, parse } from '../lib/validate.js';
import {
  discountAmount,
  discountLabel,
  discountState,
  normalizeCode,
  quoteService,
  toCents,
  VEHICLE_SIZES,
  type DiscountRule,
  type DiscountState,
  type VehicleSize,
} from './pricing.js';

export interface DiscountRecord extends DiscountRule {
  id: string;
  code: string;
  serviceCodes: string[];
  firstBookingOnly: boolean;
  onePerCustomer: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT_DISCOUNT = `SELECT id, code, kind, value, service_codes, starts_on, ends_on, max_uses, uses, paused,
  first_booking_only, one_per_customer, created_at, updated_at FROM discounts`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDiscount(r: any): DiscountRecord {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind,
    value: Number(r.value),
    serviceCodes: r.service_codes ?? [],
    startsOn: r.starts_on,
    endsOn: r.ends_on ?? null,
    maxUses: r.max_uses === null ? null : Number(r.max_uses),
    uses: Number(r.uses),
    paused: r.paused,
    firstBookingOnly: r.first_booking_only,
    onePerCustomer: r.one_per_customer,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const STATE_MESSAGES: Record<Exclude<DiscountState, 'active'>, string> = {
  expired: 'That code has expired.',
  used_up: 'That code has been fully used.',
  paused: "That code isn't active right now.",
  scheduled: "That code isn't active yet.",
};

export interface DiscountContext {
  serviceCode: string;
  serviceName: string;
  /** Service price before the code (after any sale); null when the service has no online price. */
  priceCents: number | null;
  phoneE164: string | null;
  userId: string | null;
  today: string;
}

type Evaluation = { ok: true; cents: number } | { ok: false; message: string };

async function evaluate(db: Queryable, d: DiscountRecord, ctx: DiscountContext): Promise<Evaluation> {
  const state = discountState(d, ctx.today);
  if (state !== 'active') return { ok: false, message: STATE_MESSAGES[state] };
  if (!d.serviceCodes.includes(ctx.serviceCode) || !ctx.priceCents) {
    return { ok: false, message: `That code doesn't apply to ${ctx.serviceName}.` };
  }
  if ((d.firstBookingOnly || d.onePerCustomer) && (ctx.phoneE164 || ctx.userId)) {
    const who = '(customer_phone = $1 OR ($2::UUID IS NOT NULL AND user_id = $2::UUID))';
    if (d.firstBookingOnly) {
      const prior = await db.query(`SELECT 1 FROM bookings WHERE ${who} AND status <> 'cancelled' LIMIT 1`, [ctx.phoneE164, ctx.userId]);
      if (prior.rowCount) return { ok: false, message: 'That code is for first bookings only.' };
    }
    if (d.onePerCustomer) {
      const used = await db.query(`SELECT 1 FROM bookings WHERE ${who} AND discount_id = $3 AND status <> 'cancelled' LIMIT 1`, [
        ctx.phoneE164,
        ctx.userId,
        d.id,
      ]);
      if (used.rowCount) return { ok: false, message: "You've already used that code." };
    }
  }
  return { ok: true, cents: discountAmount(d, ctx.priceCents) };
}

const invalidCode = (message: string) => new AppError('VALIDATION_FAILED', message, { discountCode: message });

/** Apply a code inside the booking transaction. Throws a field error the booking form can show. */
export async function redeemDiscount(c: Queryable, codeInput: string, ctx: DiscountContext): Promise<{ id: string; code: string; cents: number }> {
  const { rows } = await c.query(`${SELECT_DISCOUNT} WHERE code = $1 FOR UPDATE`, [normalizeCode(codeInput)]);
  if (!rows[0]) throw invalidCode("That code isn't valid.");
  const d = mapDiscount(rows[0]);
  const result = await evaluate(c, d, ctx);
  if (!result.ok) throw invalidCode(result.message);
  await c.query('UPDATE discounts SET uses = uses + 1, updated_at = now() WHERE id = $1', [d.id]);
  return { id: d.id, code: d.code, cents: result.cents };
}

/** Give a use back when a booking that used a code is cancelled. */
export async function releaseDiscount(c: Queryable, discountId: string | null): Promise<void> {
  if (discountId) await c.query('UPDATE discounts SET uses = GREATEST(uses - 1, 0), updated_at = now() WHERE id = $1', [discountId]);
}

// ---------- Booking page: "Apply code" ----------

export const checkDiscountSchema = z.object({
  code: z.string({ error: 'Enter a code' }).trim().min(1, 'Enter a code').max(30),
  serviceCode: z.string({ error: 'Choose a service' }).min(1, 'Choose a service').max(40),
  vehicleSize: z.enum(VEHICLE_SIZES as [VehicleSize, ...VehicleSize[]]).nullish(),
});

export async function checkDiscount(deps: Deps, raw: unknown, userId: string | null) {
  const input = parse(checkDiscountSchema, raw);
  const settings = await deps.settings.get();
  const service = settings.services.find((s) => s.code === input.serviceCode && s.active);
  if (!service) throw new AppError('VALIDATION_FAILED', 'Please choose a service.', { serviceCode: 'Choose a service' });
  const today = todayInZone(deps.config.TIMEZONE);
  const quote = quoteService(service, input.vehicleSize ?? null, settings.site.pricing.bySize, today);
  const { rows } = await deps.db.query(`${SELECT_DISCOUNT} WHERE code = $1`, [normalizeCode(input.code)]);
  if (!rows[0]) return { valid: false as const, message: "That code isn't valid." };
  const d = mapDiscount(rows[0]);
  // No phone number here: this endpoint is public, and answers about "first booking" or "already used" for any
  // number would reveal who has booked. Those rules are checked when the booking is made (redeemDiscount);
  // signed-in customers are checked against their own account.
  const result = await evaluate(deps.db, d, {
    serviceCode: service.code,
    serviceName: service.name,
    priceCents: quote.priceCents,
    phoneE164: null,
    userId,
    today,
  });
  if (!result.ok) return { valid: false as const, message: result.message };
  return {
    valid: true as const,
    code: d.code,
    label: discountLabel(d),
    priceEur: quote.priceCents! / 100,
    discountEur: result.cents / 100,
    totalEur: (quote.priceCents! - result.cents) / 100,
  };
}

// ---------- Admin ----------

export function discountView(d: DiscountRecord, today: string) {
  return {
    id: d.id,
    code: d.code,
    kind: d.kind,
    /** Percent, or euros for a fixed amount. */
    value: d.kind === 'percent' ? d.value : d.value / 100,
    label: discountLabel(d),
    serviceCodes: d.serviceCodes,
    startsOn: d.startsOn,
    endsOn: d.endsOn,
    maxUses: d.maxUses,
    uses: d.uses,
    paused: d.paused,
    firstBookingOnly: d.firstBookingOnly,
    onePerCustomer: d.onePerCustomer,
    status: discountState(d, today),
    createdAt: d.createdAt.toISOString(),
  };
}

export async function listDiscounts(deps: Deps) {
  const today = todayInZone(deps.config.TIMEZONE);
  const [codes, usage] = await Promise.all([
    deps.db.query(`${SELECT_DISCOUNT} ORDER BY created_at DESC`),
    deps.db.query<{ with_code: number; all_bookings: number; given_cents: number }>(
      `SELECT count(*) FILTER (WHERE discount_id IS NOT NULL AND status <> 'cancelled' AND created_at >= now() - INTERVAL '30 days') AS with_code,
              count(*) FILTER (WHERE status <> 'cancelled' AND created_at >= now() - INTERVAL '30 days') AS all_bookings,
              COALESCE(sum(discount_cents) FILTER (WHERE discount_id IS NOT NULL AND status <> 'cancelled'), 0) AS given_cents
       FROM bookings`,
    ),
  ]);
  const discounts = codes.rows.map(mapDiscount).map((d) => discountView(d, today));
  const u = usage.rows[0];
  return {
    discounts,
    stats: {
      activeCodes: discounts.filter((d) => d.status === 'active').length,
      totalCodes: discounts.length,
      timesUsed: discounts.reduce((t, d) => t + d.uses, 0),
      discountGivenEur: Number(u.given_cents) / 100,
      bookingsWithCodePct30d: Number(u.all_bookings) ? Math.round((Number(u.with_code) / Number(u.all_bookings)) * 1000) / 10 : 0,
    },
  };
}

const isWholeCents = (eur: number) => Math.abs(eur * 100 - Math.round(eur * 100)) < 1e-6;

export const discountBodySchema = z
  .object({
    code: z
      .string({ error: 'Enter a code' })
      .transform(normalizeCode)
      .pipe(z.string().regex(/^[A-Z0-9]{3,20}$/, 'Use 3–20 letters and numbers')),
    kind: z.enum(['percent', 'fixed'], { error: 'Choose % off or € off' }),
    value: z.number({ error: 'Enter an amount' }).positive('Enter an amount above 0'),
    serviceCodes: z.array(z.string().min(1).max(40)).min(1, 'Choose at least one service').max(50),
    startsOn: isoDate,
    endsOn: isoDate.nullable(),
    maxUses: z.number().int('Use a whole number').min(1, 'At least 1').max(100_000).nullable(),
    firstBookingOnly: z.boolean(),
    onePerCustomer: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'percent' && (!Number.isInteger(v.value) || v.value > 90)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Use a whole percentage up to 90' });
    }
    if (v.kind === 'fixed' && (v.value > 1000 || !isWholeCents(v.value))) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Use an amount up to €1000 in whole cents' });
    }
    if (v.endsOn && v.endsOn < v.startsOn) ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'End must be on or after the start' });
  });

async function validServices(deps: Deps, codes: string[]): Promise<string[]> {
  const known = new Set((await deps.settings.get()).services.map((s) => s.code));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) throw new AppError('VALIDATION_FAILED', 'Please check the highlighted fields.', { serviceCodes: 'Unknown service' });
  return [...new Set(codes)];
}

function codeTaken(err: unknown): never {
  if (isUniqueViolation(err, 'discounts_code_key')) {
    throw new AppError('CONFLICT', 'That code already exists.', { code: 'That code already exists' });
  }
  throw err;
}

export async function createDiscount(deps: Deps, raw: unknown) {
  const input = parse(discountBodySchema, raw);
  const services = await validServices(deps, input.serviceCodes);
  try {
    const { rows } = await deps.db.query(
      `INSERT INTO discounts (code, kind, value, service_codes, starts_on, ends_on, max_uses, first_booking_only, one_per_customer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        input.code,
        input.kind,
        input.kind === 'percent' ? input.value : toCents(input.value),
        services,
        input.startsOn,
        input.endsOn,
        input.maxUses,
        input.firstBookingOnly,
        input.onePerCustomer,
      ],
    );
    return discountView(mapDiscount(rows[0]), todayInZone(deps.config.TIMEZONE));
  } catch (err) {
    return codeTaken(err);
  }
}

export async function updateDiscount(deps: Deps, id: string, raw: unknown) {
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Discount code not found.');
  const input = parse(discountBodySchema, raw);
  const services = await validServices(deps, input.serviceCodes);
  try {
    const { rows } = await deps.db.query(
      `UPDATE discounts SET code = $2, kind = $3, value = $4, service_codes = $5, starts_on = $6, ends_on = $7, max_uses = $8,
         first_booking_only = $9, one_per_customer = $10, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        id,
        input.code,
        input.kind,
        input.kind === 'percent' ? input.value : toCents(input.value),
        services,
        input.startsOn,
        input.endsOn,
        input.maxUses,
        input.firstBookingOnly,
        input.onePerCustomer,
      ],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND', 'Discount code not found.');
    return discountView(mapDiscount(rows[0]), todayInZone(deps.config.TIMEZONE));
  } catch (err) {
    return codeTaken(err);
  }
}

export async function setDiscountPaused(deps: Deps, id: string, paused: boolean) {
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Discount code not found.');
  const { rows } = await deps.db.query('UPDATE discounts SET paused = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, paused]);
  if (!rows[0]) throw new AppError('NOT_FOUND', 'Discount code not found.');
  return discountView(mapDiscount(rows[0]), todayInZone(deps.config.TIMEZONE));
}
