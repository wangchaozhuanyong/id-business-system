import type { PaginatedResult, V2PageQuery } from '@apple-business/shared';

export interface V2ExchangeRateOperator {
  id: string;
  username: string;
  displayName: string;
}

export interface V2ExchangeRateEntry {
  id: string;
  binanceMerchantBuyRateToRmb: string;
  binanceMerchantSellRateToRmb: string;
  okxMerchantBuyRateToRmb: string;
  okxMerchantSellRateToRmb: string;
  combinedMerchantBuyAverageRateToRmb: string;
  combinedMerchantSellAverageRateToRmb: string;
  midRateToRmb: string;
  recordedAt: string;
  remark: string | null;
  createdBy: V2ExchangeRateOperator | null;
  createdAt: string;
}

export interface V2ExchangeRateSnapshotSummary {
  id: string;
  averagedAt: string;
  combinedMerchantBuyAverageRateToRmb: string;
  combinedMerchantSellAverageRateToRmb: string;
  midRateToRmb: string;
  providerSnapshotCount: number;
  validSampleCount: number;
  providers: Array<{
    provider: 'binance' | 'okx';
    side: 'merchant_buy' | 'merchant_sell';
    validAdCount: number;
    averageRateToRmb: string;
  }>;
}

export interface V2ExchangeRateRun {
  id: string;
  status: 'running' | 'success' | 'failed';
  triggerType: 'manual' | 'scheduled' | 'system';
  targetAmountRmb: string | null;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: V2ExchangeRateOperator | null;
  error: {
    code: string;
    message: string | null;
    provider: 'binance' | 'okx' | 'multiple' | 'system' | null;
    side: 'merchant_buy' | 'merchant_sell' | null;
    retryable: boolean | null;
  } | null;
  snapshot: V2ExchangeRateSnapshotSummary | null;
}

export interface V2ExchangeRateRunDetail extends Omit<V2ExchangeRateRun, 'snapshot'> {
  snapshot: Omit<
    V2ExchangeRateSnapshotSummary,
    'providerSnapshotCount' | 'validSampleCount' | 'providers'
  > | null;
  providerSnapshots: Array<{
    id: string;
    provider: 'binance' | 'okx';
    side: 'merchant_buy' | 'merchant_sell';
    sourceContract: string;
    sourceUrl: string;
    collectedAt: string;
    counts: {
      received: number;
      collectorAccepted: number;
      collectorRejected: number;
      valid: number;
      filtered: number;
    };
    exclusions: Record<string, number>;
    medianRateToRmb: string;
    lowestValidRateToRmb: string;
    highestValidRateToRmb: string;
    averageRateToRmb: string;
    validSamples: Array<{
      sourceAdId: string;
      priceToRmb: string;
      minAmountRmb: string | null;
      maxAmountRmb: string | null;
      tradableAmountUsdt: string;
      paymentMethods: string[];
      merchantType: string;
      completedOrderCount: number;
      completionRate: string;
      positiveReviewRate: string | null;
    }>;
  }>;
}

export interface V2ExchangeRateEffective {
  available: boolean;
  reason:
    | null
    | 'emergency_disabled'
    | 'never_collected'
    | 'collection_in_progress'
    | 'latest_attempt_failed'
    | 'stale';
  runId?: string;
  latestRunId?: string;
  snapshotId?: string;
  midRateToRmb?: string;
  averagedAt?: string;
  expiresAt?: string;
}

export interface V2ExchangeRateReceiptFxRate {
  currency: 'CNY' | 'MYR' | 'USDT';
  snapshotId: string | null;
  rateToCny: string | null;
  source: string | null;
  capturedAt: string | null;
  expiresAt: string | null;
  status: 'fixed' | 'available' | 'expired' | 'missing';
}

export interface V2ExchangeRateOverview {
  latestRun: V2ExchangeRateRun | null;
  lastSuccess: (V2ExchangeRateRun & { stale: boolean; expiresAt: string | null }) | null;
  effective: V2ExchangeRateEffective;
  latestReceiptFxRates: V2ExchangeRateReceiptFxRate[];
  calculationRule: string;
}

export interface V2ExchangeRateSettings {
  autoEnabled: boolean;
  intervalMinutes: number;
  targetAmountRmb: string;
  nextRunAt: string | null;
  emergencyNetworkEnabled: boolean;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  allowedIntervals: number[];
}

export interface V2ExchangeRateRuntime {
  settings: V2ExchangeRateSettings;
  scheduler: {
    tickIntervalMs: number;
    localRunning: boolean;
    lastTickAt: string | null;
    databaseRunning: {
      id: string;
      triggerType: string;
      targetAmountRmb: string | null;
      startedAt: string;
    } | null;
  };
  providers: Array<{
    code: 'binance' | 'okx';
    source: string;
    contract: string;
  }>;
  successBoundary: string;
  retention: {
    days: number;
    preservesReferencedSnapshots: boolean;
  };
}

export interface V2ExchangeRateRunListQuery extends V2PageQuery {
  keyword?: string;
  status?: '' | 'running' | 'success' | 'failed';
  triggerType?: '' | 'manual' | 'scheduled' | 'system';
  provider?: '' | 'binance' | 'okx';
  collectedFrom?: string;
  collectedTo?: string;
  sortOrder?: 'asc' | 'desc';
}

export type V2ExchangeRateRunListResult = PaginatedResult<V2ExchangeRateRun>;

export interface V2ExchangeRateListQuery extends V2PageQuery {
  keyword?: string;
  recordedFrom?: string;
  recordedTo?: string;
  sortBy?: 'recordedAt' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export type V2ExchangeRateListResult = PaginatedResult<V2ExchangeRateEntry>;

export interface CreateV2ExchangeRateEntryInput {
  binanceMerchantBuyRateToRmb: string;
  binanceMerchantSellRateToRmb: string;
  okxMerchantBuyRateToRmb: string;
  okxMerchantSellRateToRmb: string;
  recordedAt: string;
  remark?: string | null;
}

export interface UpdateV2ExchangeRateSettingsInput {
  autoEnabled: boolean;
  intervalMinutes: number;
  targetAmountRmb: string;
}
