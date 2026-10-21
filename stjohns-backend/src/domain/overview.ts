// Admin › Overview: headline figures against the previous period, the bookings chart, today's slots, what needs
// attention and recent activity, in one request.
import type { Deps } from '../deps.js';
import { getAnalyticsSummary, isAnalyticsConfigured, type AnalyticsRange } from '../integrations/google-analytics.js';
import { addDays, dayOfWeek, shortDate, todayInZone, zonedTimeToUtc } from '../lib/time.js';
import { getAvailability } from './availability.js';
import { findBookings, timeLabel } from './bookings.js';
import { loadCustomers } from './customers.js';
import { euros } from './pricing.js';

interface Figure {
  value: number;
  previous: number;
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  return addDays(date, -((dayOfWeek(date) + 6) % 7));
}

/** One point per day (7/30 days) or per Monday-starting week (90 days), zero-filled. */
export function bucketSeries(from: string, to: string, counts: Map<string, number>, granularity: 'day' | 'week') {
  const points = new Map<string, number>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const key = granularity === 'day' ? d : weekStart(d);
    points.set(key, (points.get(key) ?? 0) + (counts.get(d) ?? 0));
  }
  return [...points].map(([date, count]) => ({ date, count }));
}

type ActivityType = 'booked' | 'code_used' | 'confirmed' | 'cancelled' | 'deposit_paid' | 'completed' | 'no_show' | 'account' | 'photos';
interface Activity {
  type: ActivityType;
  at: string;
  text: string;
  reference?: string;
}

const lower = (s: string) => s.toLowerCase();

async function recentActivity(deps: Deps): Promise<Activity[]> {
  const [events, accounts, photos] = await Promise.all([
    deps.db.query<{
      type: string;
      actor: string;
      created_at: Date;
      reference: string;
      customer_name: string;
      slot_date: string;
      discount_code: string | null;
      discount_cents: number;
      service_name: string;
      period_label: string;
    }>(
      `SELECT e.type, e.actor, e.created_at, b.reference, b.customer_name, b.slot_date, b.discount_code, b.discount_cents,
              s.name AS service_name, p.label AS period_label
       FROM booking_events e
       JOIN bookings b ON b.id = e.booking_id
       JOIN services s ON s.code = b.service_code
       JOIN slot_periods p ON p.code = b.period
       WHERE e.type IN ('created', 'confirmed', 'cancelled', 'deposit_paid', 'completed', 'no_show')
       ORDER BY e.created_at DESC LIMIT 20`,
    ),
    deps.db.query<{ full_name: string; created_at: Date }>(
      "SELECT full_name, created_at FROM users WHERE role = 'customer' ORDER BY created_at DESC LIMIT 10",
    ),
    deps.db.query<{ n: number; at: Date }>(
      `SELECT count(*) AS n, max(created_at) AS at FROM gallery_items
       WHERE section = 'photo' AND created_at >= now() - INTERVAL '30 days'
       GROUP BY created_at::DATE ORDER BY at DESC LIMIT 5`,
    ),
  ]);
  const items: Activity[] = [];
  for (const e of events.rows) {
    const when = `${shortDate(e.slot_date)}, ${lower(e.period_label)}`;
    const base = { at: e.created_at.toISOString(), reference: e.reference };
    const byOwner = e.actor.startsWith('admin:');
    switch (e.type) {
      case 'created':
        items.push({ ...base, type: 'booked', text: byOwner ? `You booked a ${e.service_name} for ${e.customer_name} (${when})` : `${e.customer_name} booked a ${e.service_name} for ${when}` });
        if (e.discount_code) {
          items.push({ ...base, type: 'code_used', text: `Code ${e.discount_code} used by ${e.customer_name} (−${euros(Number(e.discount_cents))})` });
        }
        break;
      case 'confirmed':
        items.push({ ...base, type: 'confirmed', text: `${e.customer_name}'s booking for ${when} was confirmed` });
        break;
      case 'cancelled':
        items.push({ ...base, type: 'cancelled', text: byOwner ? `You cancelled ${e.customer_name}'s booking for ${when}` : `${e.customer_name} cancelled ${when} online` });
        break;
      case 'deposit_paid':
        items.push({ ...base, type: 'deposit_paid', text: `Deposit received from ${e.customer_name}` });
        break;
      case 'completed':
        items.push({ ...base, type: 'completed', text: `${e.service_name} completed for ${e.customer_name}` });
        break;
      case 'no_show':
        items.push({ ...base, type: 'no_show', text: `${e.customer_name} didn't show for ${when}` });
        break;
    }
  }
  for (const a of accounts.rows) items.push({ type: 'account', at: a.created_at.toISOString(), text: `New account created: ${a.full_name}` });
  for (const p of photos.rows) {
    const n = Number(p.n);
    items.push({ type: 'photos', at: p.at.toISOString(), text: `${n} photo${n === 1 ? '' : 's'} added to the gallery` });
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);
}

export async function getOverview(deps: Deps, range: AnalyticsRange) {
  const { config, db } = deps;
  const tz = config.TIMEZONE;
  const today = todayInZone(tz);
  const from = addDays(today, -(range - 1));
  const prevFrom = addDays(from, -range);
  const prevTo = addDays(from, -1);
  const start = zonedTimeToUtc(from, '00:00', tz);
  const prevStart = zonedTimeToUtc(prevFrom, '00:00', tz);
  const nextMonday = addDays(today, (8 - dayOfWeek(today)) % 7 || 7);

  const [totals, perDay, mix, attention, failed, todays, blocks, nextWeek, customers, activity, settings, analytics] = await Promise.all([
    db.query<{ bookings: number; prev_bookings: number; revenue: number; prev_revenue: number }>(
      `SELECT count(*) FILTER (WHERE created_at >= $1 AND status <> 'cancelled') AS bookings,
              count(*) FILTER (WHERE created_at >= $2 AND created_at < $1 AND status <> 'cancelled') AS prev_bookings,
              COALESCE(sum(COALESCE(final_price_cents, total_cents, 0)) FILTER (WHERE status = 'completed' AND slot_date BETWEEN $3 AND $4), 0) AS revenue,
              COALESCE(sum(COALESCE(final_price_cents, total_cents, 0)) FILTER (WHERE status = 'completed' AND slot_date BETWEEN $5 AND $6), 0) AS prev_revenue
       FROM bookings`,
      [start, prevStart, from, today, prevFrom, prevTo],
    ),
    db.query<{ slot_date: string; n: number }>(
      "SELECT slot_date, count(*) AS n FROM bookings WHERE slot_date BETWEEN $1 AND $2 AND status IN ('confirmed', 'completed') GROUP BY slot_date",
      [from, today],
    ),
    db.query<{ name: string; n: number }>(
      `SELECT s.name, count(*) AS n FROM bookings b JOIN services s ON s.code = b.service_code
       WHERE b.created_at >= $1 AND b.status <> 'cancelled' GROUP BY s.name ORDER BY n DESC, s.name`,
      [start],
    ),
    db.query<{ pending: number; deposits: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
              count(*) FILTER (WHERE deposit_status = 'requested' AND status IN ('pending', 'confirmed')) AS deposits
       FROM bookings WHERE slot_date >= $1`,
      [today],
    ),
    db.query<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE status = 'failed' AND kind = 'notify' AND updated_at >= now() - INTERVAL '7 days'"),
    findBookings(db, "b.slot_date = $1 AND b.status <> 'cancelled'", [today], 'ORDER BY p.sort'),
    db.query<{ period: string }>('SELECT period FROM blocked_slots WHERE slot_date = $1', [today]),
    getAvailability(deps, nextMonday, addDays(nextMonday, 5)),
    loadCustomers(deps),
    recentActivity(deps),
    deps.settings.get(),
    isAnalyticsConfigured(config) ? getAnalyticsSummary(config, range).catch(() => null) : Promise.resolve(null),
  ]);

  const t = totals.rows[0];
  const bookings: Figure = { value: Number(t.bookings), previous: Number(t.prev_bookings) };
  const revenue: Figure = { value: Number(t.revenue) / 100, previous: Number(t.prev_revenue) / 100 };
  const inRange = (iso: string, lo: Date, hi: Date) => {
    const ms = new Date(iso).getTime();
    return ms >= lo.getTime() && ms < hi.getTime();
  };
  const newCustomers: Figure = {
    value: customers.filter((c) => inRange(c.firstSeen, start, new Date(Date.now() + 60_000))).length,
    previous: customers.filter((c) => inRange(c.firstSeen, prevStart, start)).length,
  };
  const visitors: Figure | null = analytics ? { value: analytics.totals.visitors, previous: analytics.previous.visitors } : null;
  const rate = (b: number, v: number) => (v ? Math.round((b / v) * 1000) / 10 : 0);
  const conversion: Figure | null = visitors
    ? { value: rate(bookings.value, visitors.value), previous: rate(bookings.previous, visitors.previous) }
    : null;

  const counts = new Map(perDay.rows.map((r) => [r.slot_date, Number(r.n)]));
  const granularity = range === 90 ? 'week' : 'day';
  const mixTotal = mix.rows.reduce((s, r) => s + Number(r.n), 0);

  const blocked = new Set(blocks.rows.map((b) => b.period));
  const dow = dayOfWeek(today);
  const periods = settings.periods.filter((p) => p.active).sort((a, b) => a.sort - b.sort);
  const todaySlots = periods.map((p) => {
    const b = todays.find((x) => x.period === p.code);
    const base = { period: p.code, label: p.label, time: b ? timeLabel(b) : p.startTime ? `${p.startTime.slice(0, 5)}–${p.endTime?.slice(0, 5) ?? ''}` : null };
    if (b) {
      return { ...base, status: b.status, booking: { reference: b.reference, name: b.customerName, service: b.serviceName, vehicle: b.vehicle } };
    }
    const status = blocked.has('all') || blocked.has(p.code) ? 'blocked' : p.daysOfWeek.includes(dow) ? 'free' : 'closed';
    return { ...base, status, booking: null };
  });

  return {
    rangeDays: range,
    today,
    tiles: { bookings, revenue, newCustomers, visitors, conversion },
    analyticsConfigured: isAnalyticsConfigured(config),
    bookingsSeries: { granularity, points: bucketSeries(from, today, counts, granularity) },
    visitorsSeries: analytics?.daily.map((d) => ({ date: d.date, visitors: d.visitors })) ?? null,
    todaySlots,
    closedToday: periods.length > 0 && periods.every((p) => !p.daysOfWeek.includes(dow)),
    attention: {
      awaitingConfirmation: Number(attention.rows[0].pending),
      depositsUnpaid: Number(attention.rows[0].deposits),
      failedMessages: Number(failed.rows[0].n),
      slotsLeftNextWeek: nextWeek.days.reduce((s, d) => s + d.available, 0),
    },
    serviceMix: mix.rows.map((r) => ({ name: r.name, count: Number(r.n), share: mixTotal ? Math.round((Number(r.n) / mixTotal) * 100) : 0 })),
    activity,
  };
}
