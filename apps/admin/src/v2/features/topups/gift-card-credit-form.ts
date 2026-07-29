import type { V2ExchangeRateOverview } from '@/v2/types/exchangeRates';
import type { V2GiftCardCreditPayload } from './contracts';

export interface V2TopupUsdtRateReference {
  merchantBuyRateToRmb: string;
  merchantSellRateToRmb: string;
  midRateToRmb: string;
  averagedAt: string;
  stale: boolean;
}

export function resolveUsdtRateReference(
  overview: V2ExchangeRateOverview
): V2TopupUsdtRateReference | null {
  const lastSuccess = overview.lastSuccess;
  const snapshot = lastSuccess?.snapshot;
  if (!lastSuccess || !snapshot) return null;

  return {
    merchantBuyRateToRmb: snapshot.combinedMerchantBuyAverageRateToRmb,
    merchantSellRateToRmb: snapshot.combinedMerchantSellAverageRateToRmb,
    midRateToRmb: snapshot.midRateToRmb,
    averagedAt: snapshot.averagedAt,
    stale: lastSuccess.stale
  };
}

export function buildManualGiftCardCreditPayload(input: {
  code: string;
  faceValue: string;
  exchangeRate: string;
  supplierOptionId: string;
  idempotencyKey: string;
  remark: string;
}): V2GiftCardCreditPayload {
  const remark = input.remark.trim();
  return {
    code: input.code,
    faceValue: input.faceValue.trim(),
    exchangeRate: input.exchangeRate.trim(),
    supplierOptionId: input.supplierOptionId,
    idempotencyKey: input.idempotencyKey,
    ...(remark ? { remark } : {})
  };
}
