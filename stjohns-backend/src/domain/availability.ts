import type { Deps } from '../deps.js';
import { addDays, dayOfWeek, diffDays, minutesNowInZone, shortTime, timeToMinutes, todayInZone } from '../lib/time.js';
import { effectiveStart, type PeriodCode, type PeriodDef } from './settings.js';

export type SlotStatus = 'available' | 'booked' | 'unavailable';
export type UnavailableReason = 'past' | 'closed' | 'blocked' | 'too_soon' | 'beyond_window';

export interface SlotView {
  period: PeriodCode;
  label: string;
  startTime: string | null;
  endTime: string | null;
  status: SlotStatus;
  reason?: UnavailableReason;
}

export interface DayView {
  date: string;
  weekday: number;
  isToday: boolean;
  open: boolean;
  reason?: 'past' | 'closed' | 'blocked' | 'beyond_window';
  available: number;
  slots: SlotView[];
}

export interface Rules {
  today: string;
  nowMinutes: number;
  maxDaysAhead: number;
  minLeadMinutes: number;
  periods: PeriodDef[];
}

/** Why a slot can't be booked by time/calendar rules alone (ignoring existing bookings), or null if it can. */
export function slotRule(date: string, period: PeriodDef, rules: Rules): UnavailableReason | null {
  const offset = diffDays(rules.today, date);
  if (offset < 0) return 'past';
  if (offset > rules.maxDaysAhead) return 'beyond_window';
  if (!period.active || !period.daysOfWeek.includes(dayOfWeek(date))) return 'closed';
  const minutesUntilStart = offset * 1440 + timeToMinutes(effectiveStart(period)) - rules.nowMinutes;
  if (minutesUntilStart < rules.minLeadMinutes) return 'too_soon';
  return null;
}

/** Pure availability calculation; `taken` holds 'YYYY-MM-DD|period' keys, `blocked` maps a date to blocked periods or 'all'. */
export function computeAvailability(
  from: string,
  to: string,
  rules: Rules,
  taken: Set<string>,
  blocked: Map<string, Set<string>>,
): DayView[] {
  const periods = rules.periods.filter((p) => p.active).sort((a, b) => a.sort - b.sort);
  const days: DayView[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const blockedHere = blocked.get(date);
    const wholeDayBlocked = blockedHere?.has('all') ?? false;
    const slots: SlotView[] = periods.map((p) => {
      const base = { period: p.code, label: p.label, startTime: shortTime(p.startTime), endTime: shortTime(p.endTime) };
      const rule = slotRule(date, p, rules);
      if (rule === 'past' || rule === 'beyond_window' || rule === 'closed') return { ...base, status: 'unavailable', reason: rule };
      if (taken.has(`${date}|${p.code}`)) return { ...base, status: 'booked' };
      if (wholeDayBlocked || blockedHere?.has(p.code)) return { ...base, status: 'unavailable', reason: 'blocked' };
      if (rule) return { ...base, status: 'unavailable', reason: rule };
      return { ...base, status: 'available' };
    });
    const offset = diffDays(rules.today, date);
    let reason: DayView['reason'];
    if (offset < 0) reason = 'past';
    else if (offset > rules.maxDaysAhead) reason = 'beyond_window';
    else if (slots.length === 0 || slots.every((s) => s.reason === 'closed')) reason = 'closed';
    else if (wholeDayBlocked) reason = 'blocked';
    days.push({
      date,
      weekday: dayOfWeek(date),
      isToday: offset === 0,
      open: reason === undefined,
      ...(reason ? { reason } : {}),
      available: slots.filter((s) => s.status === 'available').length,
      slots,
    });
  }
  return days;
}

export async function currentRules(deps: Deps, now: Date = new Date()): Promise<Rules> {
  const { periods } = await deps.settings.get();
  const tz = deps.config.TIMEZONE;
  return {
    today: todayInZone(tz, now),
    nowMinutes: minutesNowInZone(tz, now),
    maxDaysAhead: deps.config.BOOKING_MAX_DAYS_AHEAD,
    minLeadMinutes: deps.config.BOOKING_MIN_LEAD_MINUTES,
    periods,
  };
}

export const MAX_RANGE_DAYS = 62;

export async function getAvailability(deps: Deps, from: string, to: string) {
  const rules = await currentRules(deps);
  const [taken, blocked] = await Promise.all([
    deps.db.query<{ slot_date: string; period: string }>(
      "SELECT slot_date, period FROM bookings WHERE slot_date BETWEEN $1 AND $2 AND status <> 'cancelled'",
      [from, to],
    ),
    deps.db.query<{ slot_date: string; period: string }>(
      'SELECT slot_date, period FROM blocked_slots WHERE slot_date BETWEEN $1 AND $2',
      [from, to],
    ),
  ]);
  const takenSet = new Set(taken.rows.map((r) => `${r.slot_date}|${r.period}`));
  const blockedMap = new Map<string, Set<string>>();
  for (const r of blocked.rows) {
    if (!blockedMap.has(r.slot_date)) blockedMap.set(r.slot_date, new Set());
    blockedMap.get(r.slot_date)!.add(r.period);
  }
  return {
    timezone: deps.config.TIMEZONE,
    today: rules.today,
    lastBookableDate: addDays(rules.today, rules.maxDaysAhead),
    days: computeAvailability(from, to, rules, takenSet, blockedMap),
  };
}
