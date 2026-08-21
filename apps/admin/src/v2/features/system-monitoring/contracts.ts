export type V2SystemMonitorStatus = 'healthy' | 'degraded' | 'unknown';

export interface V2SystemMonitoringCheck {
  key: string;
  title: string;
  status: V2SystemMonitorStatus;
  value: string;
  detail: string;
}

export interface V2SystemMonitoringAuthentication {
  attempts: number | null;
  failed: number | null;
  abnormal: number | null;
  activeSessions: number | null;
}

export interface V2SystemMonitoringAuthAvailability {
  alert: boolean;
  consecutiveUnavailable: number;
  sampledAt: string;
  status: 'healthy' | 'degraded';
  totalChecks: number;
  unavailableChecks: number;
  unavailableRate: number;
  windowMs: number;
}

export interface V2SystemMonitoringExchangeRate {
  executionMode: 'manual_only' | 'automatic_capable';
  settings: {
    autoEnabled: boolean;
    intervalMinutes: number;
    nextRunAt: string | null;
    updatedAt: string;
  } | null;
  latestRun: {
    id: string;
    status: 'running' | 'success' | 'failed';
    triggerType: 'manual' | 'scheduled' | 'system';
    startedAt: string;
    finishedAt: string | null;
    errorCode: string | null;
  } | null;
}

export interface V2SystemMonitoringResponse {
  overallStatus: 'healthy' | 'degraded' | 'partial';
  checks: V2SystemMonitoringCheck[];
  authentication: V2SystemMonitoringAuthentication;
  authAvailability: V2SystemMonitoringAuthAvailability;
  exchangeRate: V2SystemMonitoringExchangeRate | null;
  purchaseRate: {
    providerConfigured: boolean;
    settings: {
      autoEnabled: boolean;
      staleMinutes: number;
      abnormalChangeRate: string;
      nextRunAt: string | null;
      updatedAt: string;
    } | null;
    latestRun: {
      id: string;
      status: 'running' | 'success' | 'failed' | 'pending_review' | 'rejected';
      triggerType: 'manual' | 'scheduled' | 'system';
      startedAt: string;
      finishedAt: string | null;
      errorCode: string | null;
      abnormalCurrencyCodes: string[];
    } | null;
    latestSnapshotAt: string | null;
  } | null;
  observabilityGaps: Array<{
    key: string;
    title: string;
    status: 'unknown';
    detail: string;
  }>;
  generatedAt: string;
  probeDurationMs: number;
  timezone: 'Asia/Shanghai';
}
