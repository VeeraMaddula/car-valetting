import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { getOverview } from '../domain/overview.js';
import {
  alertSettingsSchema,
  bookingSettingsSchema,
  businessSettingsSchema,
  messageSettingsSchema,
  saveSettingsSections,
} from '../domain/site-settings.js';
import { inviteMember, listTeam, removeMember, revokeInvite } from '../domain/team.js';
import { ANALYTICS_RANGES, isAnalyticsConfigured, type AnalyticsRange } from '../integrations/google-analytics.js';
import { enqueue } from '../jobs/queue.js';
import { AppError } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { todayInZone } from '../lib/time.js';
import { parse } from '../lib/validate.js';
import { isGoogleCalendarConfigured } from '../notifications/gcal.js';
import { sendEmail } from '../notifications/resend.js';
import { sendSms } from '../notifications/sendmode.js';
import { testEmail } from '../notifications/templates.js';
import { requireAdmin } from '../plugins/auth.js';

const admin = { preHandler: async (req: Parameters<typeof requireAdmin>[0]) => void requireAdmin(req) };

const settingsBody = z.object({
  booking: bookingSettingsSchema,
  business: businessSettingsSchema,
  alerts: alertSettingsSchema,
  messages: messageSettingsSchema,
});

const rangeQuery = z.object({
  range: z.coerce
    .number()
    .default(30)
    .refine((v): v is AnalyticsRange => (ANALYTICS_RANGES as readonly number[]).includes(v), 'Use 7, 30 or 90')
    .transform((v) => v as AnalyticsRange),
});

const providerMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Admin › Overview, Settings (business details, booking rules, alerts, messages, connected services) and Team access. */
export async function siteRoutes(app: FastifyInstance, { deps }: { deps: Deps }): Promise<void> {
  const { config, db } = deps;

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.get('/admin/overview', admin, async (req) => getOverview(deps, parse(rangeQuery, req.query).range));

  // ---------- Settings ----------

  const currentSettings = async () => {
    const { site, stored } = await deps.settings.reload();
    return {
      settings: { booking: site.booking, business: site.business, alerts: site.alerts, messages: site.messages },
      /** Sections saved from the dashboard; the others still come from the server's environment. */
      saved: Object.keys(stored),
    };
  };

  app.get('/admin/settings', admin, async () => currentSettings());

  /** "Save settings": the whole settings page in one request. Takes effect immediately (booking rules, alerts, emails). */
  app.put('/admin/settings', admin, async (req) => {
    const input = parse(settingsBody, req.body);
    await saveSettingsSections(db, input, req.user!.id);
    return currentSettings();
  });

  // ---------- Connected services ----------

  app.get('/admin/integrations', admin, async () => ({
    email: { configured: Boolean(config.RESEND_API_KEY), from: config.EMAIL_FROM },
    sms: { configured: Boolean(config.SENDMODE_ACCESS_KEY), senderId: config.SENDMODE_SENDER_ID },
    calendar: { configured: isGoogleCalendarConfigured(config) },
    analytics: { configured: isAnalyticsConfigured(config), measurementId: config.GA4_MEASUREMENT_ID ?? null },
    payments: { configured: config.stripeEnabled },
    iphoneCalendar: {
      configured: Boolean(config.ADMIN_CALENDAR_FEED_KEY),
      feedUrl: config.ADMIN_CALENDAR_FEED_KEY
        ? `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/admin/calendar.ics?key=${encodeURIComponent(config.ADMIN_CALENDAR_FEED_KEY)}`
        : null,
    },
  }));

  /** "Send test" for email: sends now (not via the queue) so the owner sees the result straight away. */
  app.post('/admin/integrations/email/test', { ...admin, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const to = config.OWNER_EMAIL ?? req.user!.email;
    let result;
    try {
      result = await sendEmail(config, { to, ...testEmail(config) }, `email-test-${randomUUID()}`);
    } catch (err) {
      throw new AppError('UPSTREAM_UNAVAILABLE', `The email was not sent. ${providerMessage(err)}`);
    }
    if (!result.sent) throw new AppError('VALIDATION_FAILED', 'Email is not set up yet: add RESEND_API_KEY to the server settings.');
    return { ok: true, to };
  });

  app.post('/admin/integrations/sms/test', { ...admin, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const phone = normalizePhone(config.OWNER_PHONE ?? req.user!.phone);
    if (!phone) throw new AppError('VALIDATION_FAILED', 'Add your mobile number under "Alerts to you" first.');
    let result;
    try {
      result = await sendSms(config, phone.e164, `Test from ${config.BUSINESS_NAME}: text messages are working.`, 'TEST');
    } catch (err) {
      throw new AppError('UPSTREAM_UNAVAILABLE', `The text was not sent. ${providerMessage(err)}`);
    }
    if (!result.sent) throw new AppError('VALIDATION_FAILED', 'Text messages are not set up yet: add SENDMODE_ACCESS_KEY to the server settings.');
    return { ok: true, to: phone.e164 };
  });

  /** "Sync now": re-send every upcoming booking to Google Calendar. */
  app.post('/admin/integrations/calendar/sync', admin, async () => {
    if (!isGoogleCalendarConfigured(config)) throw new AppError('VALIDATION_FAILED', 'Google Calendar is not connected yet.');
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM bookings WHERE slot_date >= $1 AND status IN ('pending', 'confirmed') ORDER BY slot_date LIMIT 500",
      [todayInZone(config.TIMEZONE)],
    );
    await enqueue(db, rows.map((r) => ({ kind: 'gcal.sync' as const, payload: { bookingId: r.id } })));
    deps.wakeWorker();
    return { queued: rows.length };
  });

  // ---------- Team access ----------

  app.get('/admin/team', admin, async (req) => listTeam(deps, req.user!));

  app.post('/admin/team/invites', { ...admin, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const result = await inviteMember(deps, req.body, req.user!);
    reply.status(201);
    return { ...result, ...(await listTeam(deps, req.user!)) };
  });

  app.delete('/admin/team/invites/:id', admin, async (req) => {
    await revokeInvite(deps, (req.params as { id: string }).id);
    return listTeam(deps, req.user!);
  });

  app.delete('/admin/team/members/:userId', admin, async (req) => {
    await removeMember(deps, (req.params as { userId: string }).userId, req.user!);
    return listTeam(deps, req.user!);
  });
}
