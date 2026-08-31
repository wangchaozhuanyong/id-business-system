import type { V2PurchaseRateRoundingMode } from '@apple-business/shared';

export interface UpdateIdBusinessV2PurchaseQuoteDto {
  expectedUpdatedAt?: string;
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
