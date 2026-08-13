import type { V2FinanceCurrency, V2FinanceLatestRate } from '@apple-business/shared';
import { addOneInclusiveMonthToV2DateTimeInput } from '@/v2/utils/dateTime';
import { formatV2Decimal } from '@/v2/utils/decimal';
import { getV2BusinessNowInput, getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import type { V2OrderEntryCustomer } from './contracts';

function createIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `order-${crypto.randomUUID()}`;
  }
  return `order-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createConsumptionIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `consume-${crypto.randomUUID()}`;
  }
  return `consume-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export type V2OrderReceiptFxMode = 'automatic' | 'manual';

export function createInitialOrderEntryForm() {
  const now = getV2BusinessNowInput();
  return {
    countryId: '',
    categoryId: '',
    serviceOptionId: '',
    customerId: '',
    accountId: '',
    accountSource: 'inventory' as 'inventory' | 'customer_owned',
    accountDisposition: 'retained' as 'retained' | 'sold',
    settlementPlatformOptionId: '',
    platformOrderNo: '',
    websiteAccount: '',
    receivedAmount: '',
    receivedOriginalAmount: '',
    receivedCurrency: 'CNY' as V2FinanceCurrency,
    receivedFxMode: 'automatic' as V2OrderReceiptFxMode,
    receivedFxRateToCny: '',
    receivedFxSnapshotId: '',
    automaticFxRateToCny: '',
    receivedManualRateReason: '',
    targetProfitRate: '',
    balanceAmount: '',
    openedAt: now,
    dueAt: addOneInclusiveMonthToV2DateTimeInput(now),
    remark: '',
    idempotencyKey: createIdempotencyKey()
  };
}

export type V2OrderEntryForm = ReturnType<typeof createInitialOrderEntryForm>;

export function customerLabel(customer: V2OrderEntryCustomer) {
  const detail = customer.wechat || customer.qq || customer.maskedWhatsapp || customer.maskedPhone;
  return detail ? `${customer.name} / ${detail}` : customer.name;
}

export function formatOrderEntryDecimal(value: string) {
  return formatV2Decimal(value);
}

export function applyLatestOrderEntryFxRate(
  form: V2OrderEntryForm,
  latestFxRates: V2FinanceLatestRate[],
  evaluatedAt = getV2BusinessNowMs() ?? Number.NEGATIVE_INFINITY
) {
  if (form.receivedCurrency === 'CNY' || form.receivedFxMode === 'manual') return;
  const latest = latestFxRates.find((item) => item.currency === form.receivedCurrency);
  const expired = latest?.expiresAt ? new Date(latest.expiresAt).getTime() <= evaluatedAt : false;
  form.receivedFxSnapshotId = !expired && latest?.id ? latest.id : '';
  form.automaticFxRateToCny = !expired && latest?.id && latest.rateToCny ? latest.rateToCny : '';
}
