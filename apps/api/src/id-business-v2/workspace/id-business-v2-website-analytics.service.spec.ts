import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2WebsiteAnalyticsService } from './id-business-v2-website-analytics.service';
import { IdBusinessV2WebsiteAnalyticsClient } from './providers/id-business-v2-website-analytics.client';
import { parseWebsiteAnalyticsReport } from './id-business-v2-website-analytics-report';

const admin: AuthenticatedUser = {
  id: 'admin',
  username: 'test',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const now = new Date('2026-09-05T12:00:00Z');
const headers = ['screenPageViews', 'totalUsers', 'sessions'].map((name) => ({ name }));
const values = (...counts: number[]) => counts.map((value) => ({ value: String(value) }));
const raw = () => [
  {
    metricHeaders: headers,
    dimensionHeaders: [],
    rowCount: 1,
    metadata: { timeZone: 'Asia/Kuala_Lumpur' },
    rows: [{ metricValues: values(30, 7, 12) }]
  },
  {
    metricHeaders: headers,
    dimensionHeaders: [{ name: 'date' }],
    rowCount: 2,
    metadata: { timeZone: 'Asia/Kuala_Lumpur' },
    rows: [
      { dimensionValues: [{ value: '20260904' }], metricValues: values(10, 5, 5) },
      { dimensionValues: [{ value: '20260905' }], metricValues: values(20, 6, 7) }
    ]
  }
];
function setup(configured = true) {
  const client = {
    isConfigured: vi.fn(() => configured),
    reports: vi.fn(async () => ({ reports: raw() }))
  };
  return {
    client,
    service: new IdBusinessV2WebsiteAnalyticsService(
      client as unknown as IdBusinessV2WebsiteAnalyticsClient
    )
  };
}
afterEach(() => vi.useRealTimers());

describe('website analytics report', () => {
  it('keeps distinct period visitors instead of adding daily visitors', () => {
    const result = parseWebsiteAnalyticsReport(raw(), 7, now);
    expect(result.summary).toEqual({ pageViews: 30, visitors: 7, sessions: 12 });
    expect(result.daily).toHaveLength(7);
    expect(result.daily[0]).toEqual({ date: '2026-08-30', metrics: null });
    expect(result.daily[6].metrics?.visitors).toBe(6);
  });
  it('uses property dates across UTC midnight and month boundaries', () => {
    const reports = raw().map((r) => ({ ...r, rows: [], rowCount: 0 }));
    const result = parseWebsiteAnalyticsReport(reports, 7, new Date('2026-09-01T00:00:00+08:00'));
    expect(result.daily[0].date).toBe('2026-08-26');
    expect(result.daily[6].date).toBe('2026-09-01');
    expect(result.status).toBe('empty');
    expect(result.summary).toBeNull();
  });
  it('rejects truncated or malformed upstream data rather than showing zero', () => {
    const truncated = raw();
    truncated[1].rowCount = 3;
    expect(() => parseWebsiteAnalyticsReport(truncated, 7, now)).toThrow();
    const malformed = raw();
    malformed[0].rows[0].metricValues[0].value = 'NaN';
    expect(() => parseWebsiteAnalyticsReport(malformed, 7, now)).toThrow();
    expect(() => parseWebsiteAnalyticsReport(undefined, 7, now)).toThrow();
  });
  it('accepts the live GA4 empty summary shape without accepting missing headers on data', () => {
    const emptyReports = [
      { metadata: { timeZone: 'Asia/Kuala_Lumpur' } },
      {
        dimensionHeaders: [{ name: 'date' }],
        metricHeaders: headers,
        metadata: { timeZone: 'Asia/Kuala_Lumpur' }
      }
    ];
    const result = parseWebsiteAnalyticsReport(emptyReports, 7, now);
    expect(result.status).toBe('empty');
    expect(result.summary).toBeNull();
    expect(result.daily.every((day) => day.metrics === null)).toBe(true);
    const malformed = raw();
    malformed[0].metricHeaders = [];
    expect(() => parseWebsiteAnalyticsReport(malformed, 7, now)).toThrow('Incomplete report');
  });
});

describe('website analytics access and caching', () => {
  it('denies employees before any configuration or provider access', async () => {
    const { service, client } = setup();
    await expect(service.report('7', { ...admin, roles: ['staff'] })).rejects.toThrow('仅管理员');
    await expect(service.report('7')).rejects.toThrow('仅管理员');
    expect(client.isConfigured).not.toHaveBeenCalled();
    expect(client.reports).not.toHaveBeenCalled();
  });
  it('returns an explicit unconfigured state without fabricated counts', async () => {
    const { service, client } = setup(false);
    expect(await service.report(undefined, admin)).toMatchObject({
      status: 'not_configured',
      summary: null,
      daily: []
    });
    expect(client.reports).not.toHaveBeenCalled();
    await expect(service.report('365', admin)).rejects.toThrow('近 7 天或近 30 天');
    await expect(service.report(['7'], admin)).rejects.toThrow();
  });
  it('coalesces reads and caches each bounded date range for one minute', async () => {
    vi.useFakeTimers().setSystemTime(now);
    const { service, client } = setup();
    await Promise.all([service.report('7', admin), service.report('7', admin)]);
    await service.report('7', admin);
    expect(client.reports).toHaveBeenCalledTimes(1);
    await service.report('30', admin);
    expect(client.reports).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(61_000);
    await service.report('7', admin);
    expect(client.reports).toHaveBeenCalledTimes(3);
  });
  it('sanitizes failures and allows retry without caching an empty report', async () => {
    vi.useFakeTimers().setSystemTime(now);
    const { service, client } = setup();
    client.reports.mockRejectedValueOnce(new Error('private credential details'));
    await expect(service.report('7', admin)).rejects.toThrow('访问统计读取失败');
    expect((await service.report('7', admin)).status).toBe('ready');
  });
});
