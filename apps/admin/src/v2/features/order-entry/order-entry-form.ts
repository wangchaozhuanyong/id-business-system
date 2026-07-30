import type { V2FinanceCurrency, V2FinanceLatestRate } from '@apple-business/shared';
import { calculateOneMonthInclusiveDueAt } from '@/v2/utils/subscriptionPeriod';
import { formatV2Decimal } from '@/v2/utils/decimal';
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

export function createInitialOrderEntryForm() {
  const now = new Date();
  now.setSeconds(0, 0);
  return {
    countryId: '',
    categoryId: '',
    serviceOptionId: '',
    customerId: '',
    accountId: '',
    accountDisposition: 'retained' as 'retained' | 'sold',
    settlementPlatformOptionId: '',
    platformOrderNo: '',
    websiteAccount: '',
    receivedAmount: '',
    receivedOriginalAmount: '',
    receivedCurrency: 'CNY' as V2FinanceCurrency,
    receivedFxRateToCny: '',
    receivedFxSnapshotId: '',
    automaticFxRateToCny: '',
    receivedManualRateReason: '',
    targetProfitRate: '',
    balanceAmount: '',
    openedAt: now,
    dueAt: calculateOneMonthInclusiveDueAt(now),
    remark: '',
    idempotencyKey: createIdempotencyKey()
  };
}

export type V2OrderEntryForm = ReturnType<typeof createInitialOrderEntryForm>;

export function customerLabel(customer: V2OrderEntryCustomer) {
  const detail = customer.wechat || customer.maskedPhone;
  return detail ? `${customer.name} / ${detail}` : customer.name;
}

export function formatOrderEntryDecimal(value: string) {
  return formatV2Decimal(value);
}

export function applyLatestOrderEntryFxRate(
  form: V2OrderEntryForm,
  latestFxRates: V2FinanceLatestRate[],
  evaluatedAt = Date.now()
) {
  if (form.receivedCurrency === 'CNY' || form.receivedFxRateToCny) return;
  const latest = latestFxRates.find((item) => item.currency === form.receivedCurrency);
  const expired = latest?.expiresAt ? new Date(latest.expiresAt).getTime() <= evaluatedAt : false;
  form.receivedFxSnapshotId = !expired && latest?.id ? latest.id : '';
  form.automaticFxRateToCny = !expired && latest?.id && latest.rateToCny ? latest.rateToCny : '';
}
