export const ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER = 'exchange_rate_api' as const;

export interface IdBusinessV2PurchaseRateProviderResult {
  provider: typeof ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER;
  baseCurrency: 'CNY';
  providerUpdatedAt: Date;
  quotePerCny: Record<string, string>;
  sourceContract: string;
  sourceReference: string;
}

export interface IdBusinessV2PurchaseRateProvider {
  fetchLatest(currencyCodes: string[]): Promise<IdBusinessV2PurchaseRateProviderResult>;
}

export interface IdBusinessV2PurchaseRateCandidateQuote {
  currencyCode: string;
  marketRateCnyPerUnit: string;
  providerQuotePerCny: string;
  purchaseRatio: string;
  quoteUnit: string;
  purchaseRateRaw: string;
  purchaseRateDisplay: string;
  decimalPlaces: number;
  roundingMode: 'ROUND_DOWN' | 'ROUND_HALF_UP' | 'ROUND_UP';
  previousMarketRateCnyPerUnit: string | null;
  changeRate: string | null;
  abnormal: boolean;
}

export class IdBusinessV2PurchaseRateProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'IdBusinessV2PurchaseRateProviderError';
  }
}
