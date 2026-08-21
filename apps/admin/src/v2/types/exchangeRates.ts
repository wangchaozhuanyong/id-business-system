import type { PaginatedResult, V2PageQuery } from '@apple-business/shared';
import type { V2PurchaseRateRoundingMode } from '@apple-business/shared';

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

export type V2ExchangeRateCurrency = 'CNY' | 'MYR' | 'USD' | 'USDT';
export type V2TrackedExchangeRateCurrency = Exclude<V2ExchangeRateCurrency, 'CNY'>;

export interface V2ExchangeRateRecord {
  id: string;
  currency: V2TrackedExchangeRateCurrency;
  rateToCny: string;
  source: 'combined_p2p' | 'binance' | 'okx' | 'ecb_cross';
  sourceReference: string | null;
  sourceEvidence: Record<string, unknown> | null;
  businessDate: string;
  capturedAt: string;
  expiresAt: string | null;
  status: 'available' | 'expired';
  exchangeRateRunId: string | null;
  createdBy: V2ExchangeRateOperator | null;
}

export interface V2ManualFxRate {
  id: string;
  currency: V2TrackedExchangeRateCurrency;
  rateToCny: string;
  source: 'manual';
  sourceReference: string | null;
  businessDate: string;
  recordedAt: string;
  capturedAt: string;
  expiresAt: string | null;
  reason: string | null;
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
  currency: V2ExchangeRateCurrency;
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
  retentionDays: number;
  nextRunAt: string | null;
  emergencyNetworkEnabled: boolean;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  allowedIntervals: number[];
  allowedRetentionDays: {
    min: number;
    max: number;
  };
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
    code: 'binance' | 'okx' | 'ecb';
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

export interface V2ExchangeRateRecordListQuery extends V2PageQuery {
  currency?: '' | V2TrackedExchangeRateCurrency;
  source?: '' | 'combined_p2p' | 'binance' | 'okx' | 'ecb_cross';
  status?: '' | 'available' | 'expired';
  capturedFrom?: string;
  capturedTo?: string;
  sortOrder?: 'asc' | 'desc';
}

export type V2ExchangeRateRecordListResult = PaginatedResult<V2ExchangeRateRecord>;

export interface V2ExchangeRateListQuery extends V2PageQuery {
  keyword?: string;
  recordedFrom?: string;
  recordedTo?: string;
  sortBy?: 'recordedAt' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export type V2ExchangeRateListResult = PaginatedResult<V2ExchangeRateEntry>;

export interface V2ManualFxRateListQuery extends V2PageQuery {
  keyword?: string;
  currency?: '' | V2TrackedExchangeRateCurrency;
  recordedFrom?: string;
  recordedTo?: string;
  sortOrder?: 'asc' | 'desc';
}

export type V2ManualFxRateListResult = PaginatedResult<V2ManualFxRate>;

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
  retentionDays: number;
}

export interface CreateV2ManualFxRateInput {
  currency: V2TrackedExchangeRateCurrency;
  rateToCny: string;
  recordedAt: string;
  reason: string;
  sourceReference?: string | null;
}

export interface V2PurchaseRateSnapshot {
  id: string;
  currencyCode: string;
  marketRateCnyPerUnit: string;
  purchaseRatio: string;
  quoteUnit: string;
  purchaseRateRaw: string;
  purchaseRateDisplay: string;
  purchaseRateFormatted: string;
  decimalPlaces: number;
  roundingMode: V2PurchaseRateRoundingMode;
  marketRateSource: 'manual' | 'currencyapi';
  marketRateSourceReference: string | null;
  marketRateCapturedAt: string;
  fetchRunId: string | null;
  changeRate: string | null;
  validationStatus: 'normal' | 'confirmed_abnormal';
  staleAt: string;
  stale: boolean;
  createdBy: V2ExchangeRateOperator | null;
  createdAt: string;
}

export interface V2PurchaseQuote {
  code: string;
  nameCn: string;
  displayName: string | null;
  purchaseRatio: string;
  purchaseRatioPercent: string;
  quoteUnit: string;
  decimalPlaces: number;
  roundingMode: V2PurchaseRateRoundingMode;
  enabled: boolean;
  sortOrder: number;
  updatedBy: V2ExchangeRateOperator | null;
  createdAt: string;
  updatedAt: string;
  latestSnapshot: V2PurchaseRateSnapshot | null;
}

export interface V2PurchaseQuoteList {
  items: V2PurchaseQuote[];
  calculationRule: string;
  marketRateMode: 'automatic_with_manual_fallback';
  marketRateNotice: string;
  staleMinutes: number;
}

export interface UpdateV2PurchaseQuoteInput {
  nameCn: string;
  displayName?: string | null;
  purchaseRatioPercent: string;
  quoteUnit: string;
  decimalPlaces: number;
  roundingMode: V2PurchaseRateRoundingMode;
  enabled: boolean;
  sortOrder: number;
  marketRateCnyPerUnit?: string | null;
  marketRateCapturedAt?: string | null;
  marketRateSourceReference?: string | null;
}

export type V2PurchaseRateRunStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'pending_review'
  | 'rejected';

export interface V2PurchaseRateCandidateQuote {
  currencyCode: string;
  marketRateCnyPerUnit: string;
  providerQuotePerCny: string;
  purchaseRatio: string;
  quoteUnit: string;
  purchaseRateRaw: string;
  purchaseRateDisplay: string;
  decimalPlaces: number;
  roundingMode: V2PurchaseRateRoundingMode;
  previousMarketRateCnyPerUnit: string | null;
  changeRate: string | null;
  abnormal: boolean;
}

export interface V2PurchaseRateSettings {
  autoEnabled: boolean;
  intervalMinutes: 60;
  staleMinutes: number;
  abnormalChangeRate: string;
  abnormalChangePercent: string;
  nextRunAt: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  allowedStaleMinutes: { min: number; max: number };
}

export interface V2PurchaseRateRun {
  id: string;
  status: V2PurchaseRateRunStatus;
  triggerType: 'manual' | 'scheduled' | 'system';
  provider: 'currencyapi';
  baseCurrency: 'CNY';
  requestedCurrencyCodes: string[];
  abnormalCurrencyCodes: string[];
  startedAt: string;
  finishedAt: string | null;
  providerUpdatedAt: string | null;
  publishedAt: string | null;
  attemptCount: number;
  sourceContract: string | null;
  sourceReference: string | null;
  maximumChangeRate: string | null;
  error: { code: string; message: string | null; retryable: boolean | null } | null;
  triggeredBy: V2ExchangeRateOperator | null;
  reviewedBy: V2ExchangeRateOperator | null;
  reviewedAt: string | null;
  reviewRemark: string | null;
  snapshotCount: number;
  candidateQuotes?: V2PurchaseRateCandidateQuote[] | null;
  createdAt: string;
}

export type V2PurchaseRateRunListResult = PaginatedResult<V2PurchaseRateRun>;

export interface V2PurchaseRateRuntime {
  settings: V2PurchaseRateSettings;
  scheduler: {
    schedule: '5 * * * *';
    localTickIntervalMs: number;
    localRunning: boolean;
    lastTickAt: string | null;
    databaseRunning: V2PurchaseRateRun | null;
  };
  provider: {
    code: 'currencyapi';
    configured: boolean;
    source: string;
    contract: string;
  };
  latestRun: V2PurchaseRateRun | null;
  successBoundary: string;
  networkEnabled: boolean;
}

export interface V2PurchaseRateHistoryItem extends Omit<
  V2PurchaseRateSnapshot,
  'purchaseRateFormatted' | 'staleAt' | 'stale'
> {
  currencyName: string;
}

export type V2PurchaseRateHistoryResult = PaginatedResult<V2PurchaseRateHistoryItem>;

export interface V2PurchaseQuoteTextResult {
  format: 'wechat' | 'monospace' | 'plain';
  text: string;
  generatedAt: string;
  currencyCount: number;
  containsStaleQuotes: boolean;
}
