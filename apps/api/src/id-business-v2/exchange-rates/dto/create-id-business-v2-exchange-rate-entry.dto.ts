export interface CreateIdBusinessV2ExchangeRateEntryDto {
  binanceMerchantBuyRateToRmb: string | number;
  binanceMerchantSellRateToRmb: string | number;
  okxMerchantBuyRateToRmb: string | number;
  okxMerchantSellRateToRmb: string | number;
  recordedAt: string;
  remark?: string | null;
}
