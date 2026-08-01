export type V2BusinessMonitoringSeverity = 'critical' | 'warning' | 'info';
export type V2BusinessMonitoringCategory =
  | 'order'
  | 'balance'
  | 'renewal'
  | 'exchange_rate'
  | 'finance';

export interface V2BusinessMonitoringListQuery {
  page: number;
  pageSize: number;
  severity?: V2BusinessMonitoringSeverity;
  category?: V2BusinessMonitoringCategory;
}

export interface V2BusinessMonitoringRule {
  key: string;
  category: V2BusinessMonitoringCategory;
  severity: V2BusinessMonitoringSeverity;
  title: string;
  description: string;
}

export interface V2BusinessMonitoringFinding {
  id: string;
  ruleKey: string;
  category: V2BusinessMonitoringCategory;
  severity: V2BusinessMonitoringSeverity;
  subject: string;
  description: string;
  detectedAt: string;
  sourceType: string;
  sourceId: string;
  route: string;
  status: 'open';
  resolutionMode: 'source_state';
}

export interface V2BusinessMonitoringSummary {
  total: number;
  critical: number;
  warning: number;
  info: number;
  byCategory: Record<V2BusinessMonitoringCategory, number>;
}

export interface V2BusinessMonitoringResponse {
  rules: V2BusinessMonitoringRule[];
  summary: V2BusinessMonitoringSummary;
  result: {
    items: V2BusinessMonitoringFinding[];
    total: number;
    page: number;
    pageSize: number;
  };
  generatedAt: string;
  timezone: 'Asia/Kuala_Lumpur';
}
