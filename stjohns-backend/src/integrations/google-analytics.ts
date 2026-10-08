// Visitor statistics for the admin dashboard, read from Google Analytics 4 with the Data API.
// https://developers.google.com/analytics/devguides/reporting/data/v1
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { googleClient, googleErrorStatus } from '../lib/google-auth.js';
import { addDays, todayInZone } from '../lib/time.js';

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];
const API = 'https://analyticsdata.googleapis.com/v1beta';
const SUMMARY_TTL_MS = 5 * 60_000; // GA itself updates every few minutes; this keeps us well inside API quotas
const REALTIME_TTL_MS = 60_000;

export function isAnalyticsConfigured(config: Config): boolean {
  return Boolean(config.GOOGLE_SERVICE_ACCOUNT_JSON && config.GA4_PROPERTY_ID);
}

interface GaRow {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}
export interface GaReport {
  rows?: GaRow[];
}

interface DateRange {
  startDate: string;
  endDate: string;
}

/** The last n days including today; `offset` shifts the window back (offset = n gives the previous period). */
function window(n: number, offset = 0): DateRange {
  return { startDate: `${n - 1 + offset}daysAgo`, endDate: offset ? `${offset}daysAgo` : 'today' };
}

const desc = (metricName: string) => [{ metric: { metricName }, desc: true }];

/** Two batches (the API allows 5 reports per batch), fetched in parallel. */
export function buildRequests(n: number) {
  const cur = window(n);
  const totals = (r: DateRange) => ({
    dateRanges: [r],
    metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }, { name: 'averageSessionDuration' }],
  });
  return [
    [
      totals(cur),
      totals(window(n, n)),
      { dateRanges: [cur], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 },
      { dateRanges: [cur], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: desc('sessions'), limit: 8 },
      { dateRanges: [cur], dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'activeUsers' }], orderBys: desc('activeUsers'), limit: 5 },
    ],
    [
      { dateRanges: [cur], dimensions: [{ name: 'city' }], metrics: [{ name: 'activeUsers' }], orderBys: desc('activeUsers'), limit: 9 },
      {
        dateRanges: [cur],
        dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'userEngagementDuration' }],
        orderBys: desc('screenPageViews'),
        limit: 10,
      },
    ],
  ];
}

const num = (v: string | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const dim = (row: GaRow, i: number) => row.dimensionValues?.[i]?.value ?? '';
const met = (row: GaRow, i: number) => num(row.metricValues?.[i]?.value);

export interface Totals {
  visitors: number;
  sessions: number;
  pageViews: number;
  avgSessionSeconds: number;
}

export interface AnalyticsSummary {
  configured: true;
  rangeDays: number;
  totals: Totals;
  previous: Totals;
  daily: { date: string; visitors: number; pageViews: number }[];
  sources: { name: string; sessions: number; share: number }[];
  devices: { name: string; visitors: number; share: number }[];
  towns: { name: string; visitors: number }[];
  pages: { path: string; title: string; views: number; avgSecondsPerView: number }[];
  activeNow: number;
  fetchedAt: string;
}

function totalsOf(report: GaReport | undefined): Totals {
  const row = report?.rows?.[0];
  if (!row) return { visitors: 0, sessions: 0, pageViews: 0, avgSessionSeconds: 0 };
  return { visitors: met(row, 0), sessions: met(row, 1), pageViews: met(row, 2), avgSessionSeconds: Math.round(met(row, 3)) };
}

const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

/** Turn raw GA reports into the dashboard's shape. Pure, so it is unit-tested with fixtures. */
export function assembleSummary(n: number, today: string, first: GaReport[], second: GaReport[], realtime: GaReport): AnalyticsSummary {
  const [cur, prev, daily, sources, devices] = first;
  const [towns, pages] = second;

  // GA leaves out days with no visits; fill them so the chart has one point per day.
  const byDate = new Map<string, { visitors: number; pageViews: number }>();
  for (const row of daily?.rows ?? []) {
    const d = dim(row, 0);
    if (/^\d{8}$/.test(d)) byDate.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, { visitors: met(row, 0), pageViews: met(row, 1) });
  }
  const days: AnalyticsSummary['daily'] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    days.push({ date, ...(byDate.get(date) ?? { visitors: 0, pageViews: 0 }) });
  }

  const sourceRows = (sources?.rows ?? []).map((r) => ({ name: dim(r, 0) || 'Other', sessions: met(r, 0) }));
  const sourceTotal = sourceRows.reduce((t, r) => t + r.sessions, 0);
  const deviceRows = (devices?.rows ?? []).map((r) => ({ name: dim(r, 0) || 'other', visitors: met(r, 0) }));
  const deviceTotal = deviceRows.reduce((t, r) => t + r.visitors, 0);

  return {
    configured: true,
    rangeDays: n,
    totals: totalsOf(cur),
    previous: totalsOf(prev),
    daily: days,
    sources: sourceRows.map((r) => ({ ...r, share: share(r.sessions, sourceTotal) })),
    devices: deviceRows.map((r) => ({ name: r.name.charAt(0).toUpperCase() + r.name.slice(1), visitors: r.visitors, share: share(r.visitors, deviceTotal) })),
    towns: (towns?.rows ?? [])
      .map((r) => ({ name: dim(r, 0), visitors: met(r, 0) }))
      .filter((t) => t.name && t.name !== '(not set)')
      .slice(0, 8),
    pages: (pages?.rows ?? []).map((r) => {
      const views = met(r, 0);
      return { path: dim(r, 0), title: dim(r, 1), views, avgSecondsPerView: views ? Math.round(met(r, 1) / views) : 0 };
    }),
    activeNow: met(realtime.rows?.[0] ?? {}, 0),
    fetchedAt: new Date().toISOString(),
  };
}

// ---------- Fetching with caching ----------

const summaryCache = new Map<number, { value: Promise<AnalyticsSummary>; expires: number }>();
let realtimeCache: { value: Promise<number>; expires: number } | null = null;

async function call<T>(config: Config, path: string, data: unknown): Promise<T> {
  const client = googleClient(config, SCOPES);
  try {
    const res = await client.request<T>({ url: `${API}/properties/${config.GA4_PROPERTY_ID}:${path}`, method: 'POST', data, timeout: 10_000 });
    return res.data;
  } catch (err) {
    const status = googleErrorStatus(err);
    if (status === 403) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Google Analytics refused access. Add the service account email as a Viewer on the GA4 property.');
    }
    if (status === 400 || status === 404) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Google Analytics did not recognise the property. Check GA4_PROPERTY_ID (the numeric property ID, not the G- measurement ID).');
    }
    throw new AppError('UPSTREAM_UNAVAILABLE', 'Google Analytics is not responding right now. Try again in a minute.');
  }
}

function fetchRealtime(config: Config): Promise<number> {
  if (realtimeCache && realtimeCache.expires > Date.now()) return realtimeCache.value;
  const value = call<GaReport>(config, 'runRealtimeReport', { metrics: [{ name: 'activeUsers' }] }).then((r) => met(r.rows?.[0] ?? {}, 0));
  realtimeCache = { value, expires: Date.now() + REALTIME_TTL_MS };
  value.catch(() => {
    realtimeCache = null;
  });
  return value;
}

export async function getAnalyticsSummary(config: Config, n: AnalyticsRange): Promise<AnalyticsSummary> {
  const cached = summaryCache.get(n);
  let summary: Promise<AnalyticsSummary>;
  if (cached && cached.expires > Date.now()) {
    summary = cached.value;
  } else {
    const [firstReq, secondReq] = buildRequests(n);
    summary = Promise.all([
      call<{ reports?: GaReport[] }>(config, 'batchRunReports', { requests: firstReq }),
      call<{ reports?: GaReport[] }>(config, 'batchRunReports', { requests: secondReq }),
    ]).then(([a, b]) => assembleSummary(n, todayInZone(config.TIMEZONE), a.reports ?? [], b.reports ?? [], {}));
    summaryCache.set(n, { value: summary, expires: Date.now() + SUMMARY_TTL_MS });
    summary.catch(() => summaryCache.delete(n));
  }
  const [value, activeNow] = await Promise.all([summary, fetchRealtime(config).catch(() => 0)]);
  return { ...value, activeNow };
}
