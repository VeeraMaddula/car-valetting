// Admin › Services & prices and Sale prices. The prices page saves everything in one go (services, size
// prices, add-ons, deposit), matching the "N unsaved changes · Save changes" bar in the dashboard.
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { withTx } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { todayInZone } from '../lib/time.js';
import { isoDate, optionalTrimmed, parse, trimmed } from '../lib/validate.js';
import { saleIsLive, toCents, toEur } from './pricing.js';
import type { ServiceDef } from './settings.js';
import { pricingSettingsSchema, saveSettingsSections } from './site-settings.js';

export async function getPricing(deps: Deps) {
  const [settings, counts] = await Promise.all([
    deps.settings.reload(),
    deps.db.query<{ service_code: string; n: number }>('SELECT service_code, count(*) AS n FROM bookings GROUP BY service_code'),
  ]);
  const booked = new Map(counts.rows.map((r) => [r.service_code, Number(r.n)]));
  return {
    bySize: settings.site.pricing.bySize,
    depositEur: settings.site.pricing.depositEur,
    services: settings.services.map((s) => ({
      code: s.code,
      name: s.name,
      description: s.description,
      durationLabel: s.durationLabel,
      priceFrom: s.priceFrom,
      active: s.active,
      featured: s.featured,
      prices: { small: toEur(s.priceCents), large: toEur(s.priceLargeCents), suv: toEur(s.priceSuvCents) },
      bookings: booked.get(s.code) ?? 0,
    })),
    addons: settings.addons.map((a) => ({ id: a.id, name: a.name, priceEur: a.priceCents / 100, active: a.active })),
  };
}

const eur = z.number({ error: 'Enter a price' }).min(0, 'Use 0 or more').max(10_000, 'At most €10,000').multipleOf(0.01, 'Use whole cents');

export const pricingSchema = z
  .object({
    bySize: z.boolean(),
    depositEur: pricingSettingsSchema.shape.depositEur,
    services: z
      .array(
        z.object({
          /** null for a service added on this page. */
          code: z.string().regex(/^[a-z0-9-]{2,40}$/).nullable(),
          name: trimmed(2, 60, 'Service name'),
          description: optionalTrimmed(500, 'Description'),
          durationLabel: optionalTrimmed(40, 'Duration'),
          priceFrom: z.boolean(),
          active: z.boolean(),
          featured: z.boolean(),
          prices: z.object({ small: eur.nullable(), large: eur.nullable(), suv: eur.nullable() }),
        }),
      )
      .min(1, 'Keep at least one service')
      .max(30, 'At most 30 services'),
    addons: z
      .array(z.object({ id: z.uuid().nullable(), name: trimmed(2, 60, 'Name'), priceEur: eur, active: z.boolean() }))
      .max(30, 'At most 30 extras'),
  })
  .superRefine((v, ctx) => {
    v.services.forEach((s, i) => {
      if (s.active && s.prices.small === null) {
        ctx.addIssue({ code: 'custom', path: ['services', i, 'prices', 'small'], message: 'Set a price before making this bookable online' });
      }
      if (v.bySize && s.active) {
        for (const size of ['large', 'suv'] as const) {
          if (s.prices[size] === null) ctx.addIssue({ code: 'custom', path: ['services', i, 'prices', size], message: 'Set a price for every size' });
        }
      }
    });
  });

/** 'Pet Hair & Odour' → 'pet-hair-odour'. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return slug.length >= 2 ? slug : 'service';
}

export async function savePricing(deps: Deps, raw: unknown, userId: string) {
  const input = parse(pricingSchema, raw);
  await withTx(deps.db, async (c) => {
    const { rows } = await c.query<{ code: string }>('SELECT code FROM services FOR UPDATE');
    const existing = new Set(rows.map((r) => r.code));
    const sent = input.services.filter((s) => s.code).map((s) => s.code!);
    if (sent.some((code) => !existing.has(code)) || [...existing].some((code) => !sent.includes(code)) || new Set(sent).size !== sent.length) {
      throw new AppError('CONFLICT', 'The service list changed in another window. Reload the page and try again.');
    }
    const taken = new Set(existing);
    for (const [i, s] of input.services.entries()) {
      const prices = [s.prices.small, s.prices.large, s.prices.suv].map((p) => (p === null ? null : toCents(p)));
      if (s.code) {
        await c.query(
          `UPDATE services SET name = $2, description = $3, duration_label = $4, price_from = $5, active = $6, featured = $7,
             price_cents = $8, price_large_cents = $9, price_suv_cents = $10, sort = $11
           WHERE code = $1`,
          [s.code, s.name, s.description, s.durationLabel, s.priceFrom, s.active, s.featured, ...prices, i + 1],
        );
      } else {
        let code = slugify(s.name);
        for (let n = 2; taken.has(code); n++) code = `${slugify(s.name)}-${n}`;
        taken.add(code);
        await c.query(
          `INSERT INTO services (code, name, description, duration_label, price_from, active, featured, price_cents, price_large_cents, price_suv_cents, sort)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [code, s.name, s.description, s.durationLabel, s.priceFrom, s.active, s.featured, ...prices, i + 1],
        );
      }
    }
    // Extras: the list sent is the full list (removed ones are deleted; bookings keep their own copy of name and price).
    const keep = input.addons.filter((a) => a.id).map((a) => a.id!);
    await c.query('DELETE FROM addons WHERE NOT (id = ANY($1::UUID[]))', [keep]);
    for (const [i, a] of input.addons.entries()) {
      if (a.id) {
        const res = await c.query('UPDATE addons SET name = $2, price_cents = $3, active = $4, sort = $5 WHERE id = $1', [
          a.id,
          a.name,
          toCents(a.priceEur),
          a.active,
          i + 1,
        ]);
        if (!res.rowCount) throw new AppError('CONFLICT', 'The extras changed in another window. Reload the page and try again.');
      } else {
        await c.query('INSERT INTO addons (name, price_cents, active, sort) VALUES ($1, $2, $3, $4)', [a.name, toCents(a.priceEur), a.active, i + 1]);
      }
    }
    await saveSettingsSections(c, { pricing: { bySize: input.bySize, depositEur: input.depositEur } }, userId);
  });
  return getPricing(deps);
}

// ---------- Sale prices ----------

function saleStatus(s: ServiceDef, today: string): 'none' | 'live' | 'scheduled' | 'ended' {
  if (!s.saleEnabled || s.salePriceCents === null) return 'none';
  if (saleIsLive(s, today)) return 'live';
  if (s.saleStartsOn && today < s.saleStartsOn) return 'scheduled';
  return 'ended';
}

export async function getSales(deps: Deps) {
  const settings = await deps.settings.reload();
  const today = todayInZone(deps.config.TIMEZONE);
  return {
    services: settings.services.map((s) => ({
      code: s.code,
      name: s.name,
      active: s.active,
      priceEur: toEur(s.priceCents),
      sale: { enabled: s.saleEnabled, priceEur: toEur(s.salePriceCents), startsOn: s.saleStartsOn, endsOn: s.saleEndsOn },
      status: saleStatus(s, today),
      percentOff:
        s.priceCents && s.salePriceCents !== null && s.salePriceCents < s.priceCents ? Math.round((1 - s.salePriceCents / s.priceCents) * 100) : null,
    })),
  };
}

export const salesSchema = z.object({
  sales: z
    .array(
      z
        .object({
          code: z.string().min(1).max(40),
          enabled: z.boolean(),
          priceEur: eur.nullable(),
          startsOn: isoDate.nullable(),
          endsOn: isoDate.nullable(),
        })
        .refine((v) => !v.enabled || v.priceEur !== null, { path: ['priceEur'], message: 'Enter the sale price' })
        .refine((v) => !v.startsOn || !v.endsOn || v.startsOn <= v.endsOn, { path: ['endsOn'], message: 'End must be on or after the start' }),
    )
    .max(30),
});

export async function saveSales(deps: Deps, raw: unknown) {
  const input = parse(salesSchema, raw);
  const services = new Map((await deps.settings.reload()).services.map((s) => [s.code, s]));
  const fields: Record<string, string> = {};
  input.sales.forEach((sale, i) => {
    const s = services.get(sale.code);
    if (!s) fields[`sales.${i}.code`] = 'Unknown service';
    else if (sale.enabled && (s.priceCents === null || toCents(sale.priceEur!) >= s.priceCents)) {
      fields[`sales.${i}.priceEur`] = s.priceCents === null ? 'Set a normal price first' : 'The sale price must be below the normal price';
    }
  });
  if (Object.keys(fields).length) throw new AppError('VALIDATION_FAILED', 'Please check the highlighted prices.', fields);
  await withTx(deps.db, async (c) => {
    for (const sale of input.sales) {
      await c.query(
        'UPDATE services SET sale_enabled = $2, sale_price_cents = $3, sale_starts_on = $4, sale_ends_on = $5 WHERE code = $1',
        [sale.code, sale.enabled, sale.priceEur === null ? null : toCents(sale.priceEur), sale.startsOn, sale.endsOn],
      );
    }
  });
  return getSales(deps);
}
