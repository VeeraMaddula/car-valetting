import type { Config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import type { PricedService } from './pricing.js';
import { applySettings, baseValues, parseStored, resolveSettings, type BaseValues, type SiteSettings, type StoredSettings } from './site-settings.js';

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

export interface ServiceDef extends PricedService {
  code: string;
  name: string;
  durationLabel: string | null;
  /** true = 'From €X' (varies by car size); false = fixed price. */
  priceFrom: boolean;
  description: string | null;
  active: boolean;
  /** Shown with a "Signature" badge. */
  featured: boolean;
  sort: number;
}

export interface AddonDef {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
  sort: number;
}

export interface Settings {
  periods: PeriodDef[];
  services: ServiceDef[];
  addons: AddonDef[];
  /** Owner settings with environment fallbacks filled in. */
  site: SiteSettings;
  /** Only what the owner has saved (sections missing here come from the environment). */
  stored: StoredSettings;
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

/**
 * Services, slot periods and owner settings change rarely; keep them in memory and refresh in the background.
 * Each load also points the shared config at the owner's saved settings (see applySettings).
 */
export class SettingsCache {
  private value: Settings | null = null;
  private loadedAt = 0;
  private inflight: Promise<Settings> | null = null;
  private readonly base: BaseValues;

  constructor(
    private readonly db: Queryable,
    private readonly config: Config,
    private readonly ttlMs = 60_000,
  ) {
    this.base = baseValues(config);
  }

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

  /** Load fresh values now (after an admin change). */
  async reload(): Promise<Settings> {
    // A background refresh already running may have read the database before the change was saved;
    // let it finish, then load again, so the saved values are what gets cached and applied.
    await this.inflight?.catch(() => undefined);
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
    const [periods, services, addons, site] = await Promise.all([
      this.db.query(
        'SELECT code, label, start_time, end_time, days_of_week, sort, active FROM slot_periods ORDER BY sort, code',
      ),
      this.db.query(
        `SELECT code, name, duration_label, price_cents, price_large_cents, price_suv_cents, price_from, description, active, featured, sort,
                sale_enabled, sale_price_cents, sale_starts_on, sale_ends_on
         FROM services ORDER BY sort, code`,
      ),
      this.db.query('SELECT id, name, price_cents, active, sort FROM addons ORDER BY sort, created_at'),
      this.db.query("SELECT value FROM app_settings WHERE key = 'site'"),
    ]);
    const stored = parseStored(site.rows[0]?.value);
    applySettings(this.config, this.base, stored);
    const cents = (v: unknown) => (v === null || v === undefined ? null : Number(v));
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
        priceCents: cents(r.price_cents),
        priceLargeCents: cents(r.price_large_cents),
        priceSuvCents: cents(r.price_suv_cents),
        priceFrom: r.price_from ?? true,
        description: r.description ?? null,
        active: r.active,
        featured: r.featured ?? false,
        sort: Number(r.sort),
        saleEnabled: r.sale_enabled ?? false,
        salePriceCents: cents(r.sale_price_cents),
        saleStartsOn: r.sale_starts_on ?? null,
        saleEndsOn: r.sale_ends_on ?? null,
      })),
      addons: addons.rows.map((r) => ({ id: r.id, name: r.name, priceCents: Number(r.price_cents), active: r.active, sort: Number(r.sort) })),
      site: resolveSettings(this.base, stored),
      stored,
    };
    this.value = value;
    this.loadedAt = Date.now();
    return value;
  }
}
