export const V2_FLASHCAST_ANALYTICS = {
  siteUrl: 'https://flashcast.com.my',
  propertyId: '540413787',
  streamId: '15010607367',
  measurementId: 'G-LLJGRG2YNP',
  reportUrl: 'https://analytics.google.com/analytics/web/#/a396903314p540413787/reports'
} as const;

export type V2WebsiteAnalyticsDays = 7 | 30;

export interface V2WebsiteTrafficMetrics {
  pageViews: number;
  visitors: number;
  sessions: number;
}

export interface V2WebsiteAnalyticsReport {
  status: 'not_configured' | 'ready' | 'empty';
  days: V2WebsiteAnalyticsDays;
  fetchedAt: string;
  timeZone: string | null;
  utcOffset: string | null;
  thresholded: boolean;
  summary: V2WebsiteTrafficMetrics | null;
  daily: Array<{ date: string; metrics: V2WebsiteTrafficMetrics | null }>;
}
