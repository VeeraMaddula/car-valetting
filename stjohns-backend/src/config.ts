import { z } from 'zod';

const flag = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: flag(true),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  PUBLIC_SITE_URL: z.url(),
  PUBLIC_API_URL: z.url(),
  ALLOWED_ORIGINS: z.string().default(''),
  COOKIE_DOMAIN: optionalString,
  // 'lax' when the site and API share a registrable domain (www./api. of the .ie domain). 'none' only while they
  // sit on different sites, e.g. two *.onrender.com hosts (a public-suffix domain), or browsers drop the cookie.
  COOKIE_SAMESITE: z.enum(['lax', 'none']).default('lax'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  TIMEZONE: z.string().default('Europe/Dublin'),
  BOOKING_MAX_DAYS_AHEAD: z.coerce.number().int().min(1).max(365).default(84),
  BOOKING_MIN_LEAD_MINUTES: z.coerce.number().int().min(0).max(10080).default(120),
  CANCEL_CUTOFF_HOURS: z.coerce.number().int().min(0).max(720).default(24),

  BUSINESS_NAME: z.string().default('St Johns Park Car Valeting Service'),
  BUSINESS_PHONE: z.string().default('089 470 9672'),
  BUSINESS_ADDRESS: z.string().default('19 Saint Lawrence Terrace, Ballytruckle, St Johns Park, Waterford, X91 H79Y'),
  OWNER_EMAIL: optionalString,
  OWNER_PHONE: optionalString,
  DEPOSIT_AMOUNT_EUR: z.coerce.number().min(0).default(30),
  DEPOSIT_INSTRUCTIONS: z.string().default('We will send you a secure link to pay the deposit.'),

  RESEND_API_KEY: optionalString,
  EMAIL_FROM: z.string().default('St Johns Park Valeting <bookings@example.com>'),
  EMAIL_REPLY_TO: optionalString,

  SENDMODE_ACCESS_KEY: optionalString,
  SENDMODE_SENDER_ID: z.string().max(11).default('StJohnsPark'),
  SENDMODE_NUMBER_FORMAT: z.enum(['international', 'national']).default('international'),

  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString,
  GOOGLE_CALENDAR_ID: optionalString,
  GA4_PROPERTY_ID: optionalString.refine((v) => v === undefined || /^\d+$/.test(v), {
    message: 'GA4_PROPERTY_ID is the numeric property ID (Admin › Property settings), not the G- measurement ID',
  }),
  GA4_MEASUREMENT_ID: optionalString.refine((v) => v === undefined || /^G-[A-Z0-9]+$/.test(v), {
    message: 'GA4_MEASUREMENT_ID looks like G-XXXXXXXXXX',
  }),

  ADMIN_CALENDAR_FEED_KEY: optionalString.refine((v) => v === undefined || v.length >= 24, {
    message: 'ADMIN_CALENDAR_FEED_KEY must be at least 24 characters',
  }),

  // Stripe Checkout for the deposit. Leave both empty to keep the manual "we'll send you a link" flow.
  STRIPE_SECRET_KEY: optionalString.refine((v) => v === undefined || /^(sk|rk)_(test|live)_/.test(v), {
    message: 'STRIPE_SECRET_KEY looks like sk_test_… or sk_live_…',
  }),
  STRIPE_WEBHOOK_SECRET: optionalString.refine((v) => v === undefined || v.startsWith('whsec_'), {
    message: 'STRIPE_WEBHOOK_SECRET looks like whsec_…',
  }),
  // Hours a deposit link stays valid before Stripe expires it (min 0.5, max 24 per Stripe).
  DEPOSIT_LINK_HOURS: z.coerce.number().min(0.5).max(24).default(24),
  // Staging only: lets a production build run against Stripe's sandbox. Must be unset on the live site.
  STRIPE_ALLOW_TEST_KEY: flag(false),

  WORKER_ENABLED: flag(true),
});

export type Config = z.infer<typeof schema> & { allowedOrigins: string[]; isProduction: boolean; stripeEnabled: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  const allowedOrigins = cfg.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (allowedOrigins.length === 0) allowedOrigins.push(new URL(cfg.PUBLIC_SITE_URL).origin);
  if (cfg.NODE_ENV === 'production') {
    // A production database must be encrypted and certificate-checked.
    const sslmode = new URL(cfg.DATABASE_URL).searchParams.get('sslmode');
    if (sslmode !== 'verify-full') {
      throw new Error('Invalid environment configuration:\n  - DATABASE_URL: add ?sslmode=verify-full for production (Neon and Supabase connection strings support it)');
    }
  }
  if (cfg.STRIPE_SECRET_KEY && !cfg.STRIPE_WEBHOOK_SECRET) {
    throw new Error('Invalid environment configuration:\n  - STRIPE_WEBHOOK_SECRET: required when STRIPE_SECRET_KEY is set (deposits would never be marked paid)');
  }
  if (cfg.STRIPE_SECRET_KEY && cfg.NODE_ENV === 'production' && cfg.STRIPE_SECRET_KEY.includes('_test_') && !cfg.STRIPE_ALLOW_TEST_KEY) {
    throw new Error(
      'Invalid environment configuration:\n  - STRIPE_SECRET_KEY: a test key cannot be used in production (set STRIPE_ALLOW_TEST_KEY=true on a staging deploy only)',
    );
  }
  return {
    ...cfg,
    allowedOrigins,
    isProduction: cfg.NODE_ENV === 'production',
    stripeEnabled: Boolean(cfg.STRIPE_SECRET_KEY && cfg.STRIPE_WEBHOOK_SECRET && cfg.DEPOSIT_AMOUNT_EUR > 0),
  };
}
