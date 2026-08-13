import type { V2GiftCardCreditPayload } from './contracts';

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

export function buildManualGiftCardCreditPayload(input: {
  code: string;
  faceValue: string;
  cardNameOptionId: string;
  countryOptionId: string;
  exchangeRate: string;
  supplierOptionId: string;
  creditedAt: string;
  idempotencyKey: string;
  confirmedSoldByOrderId?: string;
  remark: string;
}): V2GiftCardCreditPayload {
  const remark = input.remark.trim();
  return {
    code: input.code,
    faceValue: input.faceValue.trim(),
    cardNameOptionId: input.cardNameOptionId,
    countryOptionId: input.countryOptionId,
    exchangeRate: input.exchangeRate.trim(),
    supplierOptionId: input.supplierOptionId,
    creditedAt: input.creditedAt,
    idempotencyKey: input.idempotencyKey,
    ...(input.confirmedSoldByOrderId
      ? { confirmedSoldByOrderId: input.confirmedSoldByOrderId }
      : {}),
    ...(remark ? { remark } : {})
  };
}
