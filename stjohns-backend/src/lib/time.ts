// Date helpers that work in the business's time zone (Europe/Dublin) without a tz library.
// Calendar dates are plain 'YYYY-MM-DD' strings; arithmetic on them is done in UTC so DST never shifts a day.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock time of an instant in a time zone. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(instant)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Today's calendar date in the zone, e.g. '2026-10-02'. */
export function todayInZone(tz: string, now: Date = new Date()): string {
  const p = zonedParts(now, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Minutes since local midnight in the zone. */
export function minutesNowInZone(tz: string, now: Date = new Date()): number {
  const p = zonedParts(now, tz);
  return p.hour * 60 + p.minute;
}

/** The UTC instant for a wall-clock date + time in the zone (handles DST). */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = target - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 'HH:MM' or 'HH:MM:SS' → minutes since midnight. */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** 'HH:MM:SS' → 'HH:MM'. */
export function shortTime(time: string | null): string | null {
  return time ? time.slice(0, 5) : null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'Saturday 3 October 2026'. */
export function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[dayOfWeek(date)]} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** 'Sat 3 Oct'. */
export function shortDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[dayOfWeek(date)].slice(0, 3)} ${d} ${MONTHS[m - 1].slice(0, 3)}`;
}
