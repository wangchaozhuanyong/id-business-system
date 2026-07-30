import type { V2ExchangeRateOverview } from '@/v2/types/exchangeRates';
import type { V2GiftCardCreditPayload } from './contracts';
import type { V2FinanceCurrency } from '@apple-business/shared';

export interface V2TopupUsdtRateReference {
  merchantBuyRateToRmb: string;
  merchantSellRateToRmb: string;
  midRateToRmb: string;
  averagedAt: string;
  stale: boolean;
}

export function normalizeGiftCardCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function getGiftCardCodeError(value: string) {
  const normalized = normalizeGiftCardCode(value);
  if (
    !/^[A-Z0-9]{10,64}$/.test(normalized) ||
    !/[A-Z]/.test(normalized) ||
    !/\d/.test(normalized)
  ) {
    return '礼品卡号必须是 10 至 64 位且同时包含字母和数字';
  }
  return '';
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
  purchaseOriginalAmount: string;
  purchaseCurrency: V2FinanceCurrency;
  purchaseFxRateToCny: string;
  purchaseSourceId: string;
  purchaseManualRateReason: string;
  paidAt: string;
  supplierOptionId: string;
  idempotencyKey: string;
  remark: string;
}): V2GiftCardCreditPayload {
  const remark = input.remark.trim();
  const [sourceType, sourceId] = input.purchaseSourceId.split(':', 2);
  return {
    code: input.code,
    faceValue: input.faceValue.trim(),
    purchaseOriginalAmount: input.purchaseOriginalAmount.trim(),
    purchaseCurrency: input.purchaseCurrency,
    ...(input.purchaseFxRateToCny.trim()
      ? { purchaseFxRateToCny: input.purchaseFxRateToCny.trim() }
      : {}),
    ...(sourceType === 'account' ? { purchaseFinanceAccountId: sourceId } : {}),
    ...(sourceType === 'wallet' ? { purchaseSupplierAccountId: sourceId } : {}),
    ...(input.purchaseManualRateReason.trim()
      ? { purchaseManualRateReason: input.purchaseManualRateReason.trim() }
      : {}),
    paidAt: input.paidAt,
    supplierOptionId: input.supplierOptionId,
    idempotencyKey: input.idempotencyKey,
    ...(remark ? { remark } : {})
  };
}
