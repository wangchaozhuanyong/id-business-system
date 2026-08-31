export interface BulkUpdateIdBusinessV2PurchaseQuotesDto {
  currencyCodes: string[];
  expectedUpdatedAtByCode?: Record<string, string>;
  purchaseRatioPercent: string;
}
