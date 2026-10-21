// Owner-editable settings (admin › Settings, Prices, Photos). Stored as one JSON document in app_settings
// under the key 'site'. Values not saved yet fall back to the environment (.env), so a fresh install behaves
// exactly as configured until the owner changes something.
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { normalizePhone } from '../lib/phone.js';
import { optionalTrimmed, trimmed } from '../lib/validate.js';

const channelPair = z.object({ email: z.boolean(), sms: z.boolean() });

const optionalEmail = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.email('Enter a valid email address').max(254).nullable(),
);

const optionalMobile = optionalTrimmed(30, 'Mobile number').refine((v) => v === null || normalizePhone(v) !== null, 'Enter a valid phone number');

export const bookingSettingsSchema = z.object({
  paused: z.boolean(),
  pausedMessage: optionalTrimmed(300, 'Message'),
  // Limits match what the environment allows (BOOKING_MIN_LEAD_MINUTES ≤ 7 days, CANCEL_CUTOFF_HOURS ≤ 720),
  // so saving this page never silently shortens a policy set in .env.
  maxWeeksAhead: z.number().int().min(1, 'At least 1 week').max(52, 'At most 52 weeks'),
  minNoticeHours: z.number().int().min(0).max(168, 'At most 168 hours (7 days)'),
  cancelCutoffHours: z.number().int().min(0).max(720, 'At most 720 hours (30 days)'),
  autoConfirm: z.boolean(),
});

export const businessSettingsSchema = z.object({
  name: trimmed(2, 80, 'Business name'),
  phone: trimmed(6, 30, 'Phone'),
  publicEmail: optionalEmail,
  address: trimmed(5, 200, 'Address'),
  openingHours: z.array(z.object({ label: trimmed(1, 40, 'Days'), hours: trimmed(1, 40, 'Hours') })).max(7),
});

export const alertSettingsSchema = z.object({
  ownerEmail: optionalEmail,
  ownerPhone: optionalMobile,
  newBooking: channelPair,
  customerCancels: channelPair,
  dailySummary: z.boolean(),
});

export const messageSettingsSchema = z
  .object({
    reminder: z.boolean(),
    reviewRequest: z.boolean(),
    googleReviewUrl: optionalTrimmed(500, 'Review link').refine((v) => v === null || /^https:\/\/\S+$/.test(v), 'Use a full https:// link'),
  })
  .refine((v) => !v.reviewRequest || v.googleReviewUrl, { path: ['googleReviewUrl'], message: 'Add your Google review link to send review requests' });

export const pricingSettingsSchema = z.object({
  bySize: z.boolean(),
  depositEur: z.number().min(0).max(500, 'At most €500').multipleOf(0.01, 'Use whole cents'),
});

export const slideshowSettingsSchema = z.object({
  seconds: z.number().int().min(3, 'At least 3 seconds').max(10, 'At most 10 seconds'),
});

const SECTIONS = {
  booking: bookingSettingsSchema,
  business: businessSettingsSchema,
  alerts: alertSettingsSchema,
  messages: messageSettingsSchema,
  pricing: pricingSettingsSchema,
  slideshow: slideshowSettingsSchema,
} as const;

export type SectionName = keyof typeof SECTIONS;
export type SiteSettings = { [K in SectionName]: z.output<(typeof SECTIONS)[K]> };
/** Only the sections the owner has saved; the rest come from the environment. */
export type StoredSettings = Partial<SiteSettings>;

/** The environment values settings can override, captured once at startup. */
export type BaseValues = Pick<
  Config,
  | 'BUSINESS_NAME'
  | 'BUSINESS_PHONE'
  | 'BUSINESS_ADDRESS'
  | 'OWNER_EMAIL'
  | 'OWNER_PHONE'
  | 'BOOKING_MAX_DAYS_AHEAD'
  | 'BOOKING_MIN_LEAD_MINUTES'
  | 'CANCEL_CUTOFF_HOURS'
  | 'DEPOSIT_AMOUNT_EUR'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
>;

export function baseValues(config: Config): BaseValues {
  const {
    BUSINESS_NAME,
    BUSINESS_PHONE,
    BUSINESS_ADDRESS,
    OWNER_EMAIL,
    OWNER_PHONE,
    BOOKING_MAX_DAYS_AHEAD,
    BOOKING_MIN_LEAD_MINUTES,
    CANCEL_CUTOFF_HOURS,
    DEPOSIT_AMOUNT_EUR,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
  } = config;
  return {
    BUSINESS_NAME,
    BUSINESS_PHONE,
    BUSINESS_ADDRESS,
    OWNER_EMAIL,
    OWNER_PHONE,
    BOOKING_MAX_DAYS_AHEAD,
    BOOKING_MIN_LEAD_MINUTES,
    CANCEL_CUTOFF_HOURS,
    DEPOSIT_AMOUNT_EUR,
    STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET,
  };
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function defaultSettings(base: BaseValues): SiteSettings {
  return {
    booking: {
      paused: false,
      pausedMessage: null,
      maxWeeksAhead: clamp(Math.round(base.BOOKING_MAX_DAYS_AHEAD / 7), 1, 52),
      minNoticeHours: clamp(Math.round(base.BOOKING_MIN_LEAD_MINUTES / 60), 0, 168),
      cancelCutoffHours: clamp(base.CANCEL_CUTOFF_HOURS, 0, 720),
      autoConfirm: false,
    },
    business: { name: base.BUSINESS_NAME, phone: base.BUSINESS_PHONE, publicEmail: null, address: base.BUSINESS_ADDRESS, openingHours: [] },
    alerts: {
      ownerEmail: base.OWNER_EMAIL ?? null,
      ownerPhone: base.OWNER_PHONE ?? null,
      newBooking: { email: true, sms: true },
      customerCancels: { email: true, sms: true },
      dailySummary: false,
    },
    messages: { reminder: true, reviewRequest: false, googleReviewUrl: null },
    pricing: { bySize: false, depositEur: base.DEPOSIT_AMOUNT_EUR },
    slideshow: { seconds: 5 },
  };
}

/** Keep only well-formed saved sections (a damaged section falls back to the environment rather than breaking the site). */
export function parseStored(raw: unknown): StoredSettings {
  const stored: StoredSettings = {};
  if (!raw || typeof raw !== 'object') return stored;
  for (const name of Object.keys(SECTIONS) as SectionName[]) {
    const result = SECTIONS[name].safeParse((raw as Record<string, unknown>)[name]);
    if (result.success) (stored as Record<string, unknown>)[name] = result.data;
  }
  return stored;
}

export function resolveSettings(base: BaseValues, stored: StoredSettings): SiteSettings {
  return { ...defaultSettings(base), ...stored };
}

/**
 * Point the shared config at the saved values, so every existing use (emails, booking rules, deposits) follows
 * the dashboard. Only saved sections override the environment.
 */
export function applySettings(config: Config, base: BaseValues, stored: StoredSettings): void {
  const s = resolveSettings(base, stored);
  config.BUSINESS_NAME = s.business.name;
  config.BUSINESS_PHONE = s.business.phone;
  config.BUSINESS_ADDRESS = s.business.address;
  config.OWNER_EMAIL = s.alerts.ownerEmail ?? undefined;
  config.OWNER_PHONE = s.alerts.ownerPhone ?? undefined;
  config.BOOKING_MAX_DAYS_AHEAD = stored.booking ? s.booking.maxWeeksAhead * 7 : base.BOOKING_MAX_DAYS_AHEAD;
  config.BOOKING_MIN_LEAD_MINUTES = stored.booking ? s.booking.minNoticeHours * 60 : base.BOOKING_MIN_LEAD_MINUTES;
  config.CANCEL_CUTOFF_HOURS = stored.booking ? s.booking.cancelCutoffHours : base.CANCEL_CUTOFF_HOURS;
  config.DEPOSIT_AMOUNT_EUR = s.pricing.depositEur;
  config.stripeEnabled = Boolean(base.STRIPE_SECRET_KEY && base.STRIPE_WEBHOOK_SECRET && s.pricing.depositEur > 0);
}

export function sectionSchema<K extends SectionName>(name: K): (typeof SECTIONS)[K] {
  return SECTIONS[name];
}

/** Save sections into the settings document, leaving the others as they are. Call settings.reload() afterwards. */
export async function saveSettingsSections(db: Queryable, sections: StoredSettings, userId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('site', $1::JSONB, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = app_settings.value || excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [JSON.stringify(sections), userId],
  );
}
