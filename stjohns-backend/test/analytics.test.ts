import { describe, expect, it } from 'vitest';
import { assembleSummary, buildRequests, type GaReport } from '../src/integrations/google-analytics.js';

const row = (dims: string[], mets: (number | string)[]) => ({
  dimensionValues: dims.map((value) => ({ value })),
  metricValues: mets.map((m) => ({ value: String(m) })),
});

describe('Google Analytics requests', () => {
  it('asks for the current period and the one before it', () => {
    const [first, second] = buildRequests(30);
    expect(first).toHaveLength(5);
    expect(second.length).toBeLessThanOrEqual(5);
    expect(first[0].dateRanges[0]).toEqual({ startDate: '29daysAgo', endDate: 'today' });
    expect(first[1].dateRanges[0]).toEqual({ startDate: '59daysAgo', endDate: '30daysAgo' });
    expect(buildRequests(7)[0][1].dateRanges[0]).toEqual({ startDate: '13daysAgo', endDate: '7daysAgo' });
  });
});

describe('Google Analytics summary', () => {
  const first: GaReport[] = [
    { rows: [row([], [412, 530, 1490, '101.6'])] },
    { rows: [row([], [380, 470, 1300, 95])] },
    { rows: [row(['20261001'], [40, 120]), row(['20261003'], [55, 160])] }, // 2 Oct had no visits
    { rows: [row(['Organic Search'], [300]), row(['Direct'], [150]), row(['Organic Social'], [80])] },
    { rows: [row(['mobile'], [300]), row(['desktop'], [100]), row(['tablet'], [12])] },
  ];
  const second: GaReport[] = [
    { rows: [row(['Waterford'], [240]), row(['(not set)'], [20]), row(['Tramore'], [35])] },
    { rows: [row(['/', 'Home'], [700, 42000]), row(['/booking', 'Book a valet'], [300, 45000])] },
  ];
  const summary = assembleSummary(3, '2026-10-03', first, second, { rows: [row([], [4])] });

  it('reads totals for both periods', () => {
    expect(summary.totals).toEqual({ visitors: 412, sessions: 530, pageViews: 1490, avgSessionSeconds: 102 });
    expect(summary.previous.visitors).toBe(380);
  });

  it('returns one point per day, filling days with no visits', () => {
    expect(summary.daily).toEqual([
      { date: '2026-10-01', visitors: 40, pageViews: 120 },
      { date: '2026-10-02', visitors: 0, pageViews: 0 },
      { date: '2026-10-03', visitors: 55, pageViews: 160 },
    ]);
  });

  it('computes shares and tidies labels', () => {
    expect(summary.sources[0]).toEqual({ name: 'Organic Search', sessions: 300, share: 56.6 });
    expect(summary.devices.map((d) => d.name)).toEqual(['Mobile', 'Desktop', 'Tablet']);
    expect(summary.devices.reduce((t, d) => t + d.share, 0)).toBeCloseTo(100, 0);
    expect(summary.towns.map((t) => t.name)).toEqual(['Waterford', 'Tramore']);
    expect(summary.pages[1]).toEqual({ path: '/booking', title: 'Book a valet', views: 300, avgSecondsPerView: 150 });
    expect(summary.activeNow).toBe(4);
  });

  it('copes with an empty property (no data yet)', () => {
    const empty = assembleSummary(7, '2026-10-03', [], [], {});
    expect(empty.totals.visitors).toBe(0);
    expect(empty.daily).toHaveLength(7);
    expect(empty.sources).toEqual([]);
    expect(empty.activeNow).toBe(0);
  });
});
