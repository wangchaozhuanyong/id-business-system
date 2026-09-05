import type {
  V2WebsiteAnalyticsDays,
  V2WebsiteAnalyticsReport,
  V2WebsiteTrafficMetrics
} from '@apple-business/shared';
import type { WebsiteAnalyticsRawReport } from './providers/id-business-v2-website-analytics.client';

const METRICS = ['screenPageViews', 'totalUsers', 'sessions'];

function metrics(
  row: NonNullable<WebsiteAnalyticsRawReport['rows']>[number]
): V2WebsiteTrafficMetrics {
  const values = row.metricValues;
  if (!Array.isArray(values) || values.length !== 3) throw new Error('Invalid metrics');
  const counts = values.map(({ value }) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid count');
    const count = Number(value);
    if (!Number.isSafeInteger(count)) throw new Error('Invalid count');
    return count;
  });
  return { pageViews: counts[0], visitors: counts[1], sessions: counts[2] };
}

export function parseWebsiteAnalyticsReport(
  reports: WebsiteAnalyticsRawReport[] | undefined,
  days: V2WebsiteAnalyticsDays,
  now: Date
): V2WebsiteAnalyticsReport {
  if (!Array.isArray(reports) || reports.length !== 2) throw new Error('Missing reports');
  const [summaryReport, dailyReport] = reports;
  const timeZone = summaryReport.metadata?.timeZone;
  if (!timeZone || dailyReport.metadata?.timeZone !== timeZone) throw new Error('Invalid timezone');
  for (const report of reports) {
    // GA4 omits headers as well as rows for a dimensionless report with no matching data.
    const emptySummary =
      report === summaryReport &&
      !report.metricHeaders?.length &&
      !report.rows?.length &&
      (report.rowCount ?? 0) === 0;
    if (
      (!emptySummary &&
        report.metricHeaders?.map(({ name }) => name).join(',') !== METRICS.join(',')) ||
      report.metadata?.dataLossFromOtherRow ||
      (report.rowCount ?? 0) !== (report.rows?.length ?? 0)
    )
      throw new Error('Incomplete report');
  }
  if (
    (summaryReport.rows?.length ?? 0) > 1 ||
    (summaryReport.dimensionHeaders?.length ?? 0) !== 0 ||
    dailyReport.dimensionHeaders?.map(({ name }) => name).join(',') !== 'date'
  ) {
    throw new Error('Invalid report dimensions');
  }
  // GA4 groups dates in the property's timezone. Do not silently relabel them as local dates.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZoneName: 'longOffset'
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
  const today = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')));
  const dates = Array.from({ length: days }, (_, index) =>
    new Date(today - (days - index - 1) * 86_400_000).toISOString().slice(0, 10)
  );
  const byDate = new Map<string, V2WebsiteTrafficMetrics>();
  for (const row of dailyReport.rows ?? []) {
    const raw = row.dimensionValues?.[0]?.value;
    if (typeof raw !== 'string' || !/^\d{8}$/.test(raw) || row.dimensionValues?.length !== 1) {
      throw new Error('Invalid report date');
    }
    const date = raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8);
    if (!dates.includes(date) || byDate.has(date)) throw new Error('Unexpected report date');
    byDate.set(date, metrics(row));
  }
  const summary = summaryReport.rows?.[0] ? metrics(summaryReport.rows[0]) : null;
  if (byDate.size && !summary) throw new Error('Missing summary');
  if (!byDate.size && summary && Object.values(summary).some((value) => value > 0)) {
    throw new Error('Missing daily report');
  }
  return {
    status: byDate.size ? 'ready' : 'empty',
    days,
    fetchedAt: now.toISOString(),
    timeZone,
    utcOffset: part('timeZoneName'),
    thresholded: reports.some((report) => report.metadata?.subjectToThresholding === true),
    summary: byDate.size ? summary : null,
    daily: dates.map((date) => ({ date, metrics: byDate.get(date) ?? null }))
  };
}
