export interface V2WebsiteVisitSearch {
  days: 7 | 30;
  page: number;
  pageSize: 20 | 50;
  sort: 'newest' | 'oldest';
  ip?: string;
}

export interface V2WebsiteVisitMetrics {
  pageViews: number;
  uniqueIps: number;
}

export interface V2WebsiteVisitReport {
  status: 'not_configured' | 'empty' | 'ready';
  days: 7 | 30;
  fetchedAt: string;
  lastReceivedAt: string | null;
  summary: V2WebsiteVisitMetrics | null;
  daily: Array<{ date: string; metrics: V2WebsiteVisitMetrics | null }>;
  items: Array<{ id: string; occurredAt: string; path: string; ipMasked: string }>;
  total: number;
  page: number;
  pageSize: 20 | 50;
}
