import type { Queryable } from '../db/pool.js';

export type PeriodCode = 'morning' | 'afternoon' | 'evening';
export const PERIOD_CODES: readonly PeriodCode[] = ['morning', 'afternoon', 'evening'];

export interface PeriodDef {
  code: PeriodCode;
  label: string;
  /** 'HH:MM:SS', or null while the owner has not set the slot time yet. */
  startTime: string | null;
  endTime: string | null;
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek: number[];
  sort: number;
  active: boolean;
}

export interface ServiceDef {
  code: string;
  name: string;
  durationLabel: string | null;
  priceCents: number | null;
  active: boolean;
  sort: number;
}

export interface Settings {
  periods: PeriodDef[];
  services: ServiceDef[];
}

// Used only for lead-time, cancellation cut-offs and calendar entries while real slot times are unset.
// Customers are shown "Time TBC" rather than these values.
const FALLBACK_TIMES: Record<PeriodCode, { start: string; end: string }> = {
  morning: { start: '09:00', end: '12:00' },
  afternoon: { start: '13:00', end: '16:00' },
  evening: { start: '16:30', end: '19:30' },
};

export function effectiveStart(p: Pick<PeriodDef, 'code' | 'startTime'>): string {
  return p.startTime ? p.startTime.slice(0, 5) : FALLBACK_TIMES[p.code].start;
}

export function effectiveEnd(p: Pick<PeriodDef, 'code' | 'endTime'>): string {
  return p.endTime ? p.endTime.slice(0, 5) : FALLBACK_TIMES[p.code].end;
}

/** Services and slot periods change rarely; keep them in memory and refresh in the background. */
export class SettingsCache {
  private value: Settings | null = null;
  private loadedAt = 0;
  private inflight: Promise<Settings> | null = null;

  constructor(
    private readonly db: Queryable,
    private readonly ttlMs = 60_000,
  ) {}

  async get(): Promise<Settings> {
    const fresh = Date.now() - this.loadedAt < this.ttlMs;
    if (this.value && fresh) return this.value;
    const refresh = this.refresh();
    // Serve the previous value while refreshing so no request waits on it.
    if (this.value) {
      refresh.catch(() => undefined);
      return this.value;
    }
    return refresh;
  }

  /** Force the next get() to reload (after an admin change). */
  async reload(): Promise<Settings> {
    this.loadedAt = 0;
    this.value = null;
    return this.refresh();
  }

  private refresh(): Promise<Settings> {
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async load(): Promise<Settings> {
    const [periods, services] = await Promise.all([
      this.db.query(
        'SELECT code, label, start_time, end_time, days_of_week, sort, active FROM slot_periods ORDER BY sort, code',
      ),
      this.db.query('SELECT code, name, duration_label, price_cents, active, sort FROM services ORDER BY sort, code'),
    ]);
    const value: Settings = {
      periods: periods.rows.map((r) => ({
        code: r.code,
        label: r.label,
        startTime: r.start_time ?? null,
        endTime: r.end_time ?? null,
        daysOfWeek: (r.days_of_week ?? []).map(Number),
        sort: Number(r.sort),
        active: r.active,
      })),
      services: services.rows.map((r) => ({
        code: r.code,
        name: r.name,
        durationLabel: r.duration_label ?? null,
        priceCents: r.price_cents === null ? null : Number(r.price_cents),
        active: r.active,
        sort: Number(r.sort),
      })),
    };
    this.value = value;
    this.loadedAt = Date.now();
    return value;
  }
}
