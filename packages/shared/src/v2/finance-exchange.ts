import {
  addDecimalStrings,
  divideDecimalStrings,
  multiplyDecimalStrings,
  isV2UnsignedDecimal
} from './decimal.js';
import type { V2FinanceCurrency, V2FinanceJournalStatus } from './finance.js';
export type V2FinanceExchangeFeeMode = 'source_extra' | 'target_deducted';
export interface V2FinanceExchangeWrite {
  sourceAccountId: string;
  targetAccountId: string;
  sourceCurrency: V2FinanceCurrency;
  targetCurrency: V2FinanceCurrency;
  sourceAmount: string;
  targetAmount: string;
  feeMode: V2FinanceExchangeFeeMode;
  feeAmount: string;
  occurredAt: string;
  channel?: string;
  remark?: string;
  idempotencyKey: string;
  sourceFxSnapshotId?: string;
  targetFxSnapshotId?: string;
  sourceFxRateToCny?: string;
  targetFxRateToCny?: string;
  manualRateReason?: string;
}
export interface V2FinanceExchangeCalculation {
  totalDebit: string;
  grossTargetAmount: string;
  feePercent: string;
  exchangeRate: string;
  effectiveRate: string;
  reverseRate: string;
}
export interface V2FinanceExchange extends V2FinanceExchangeWrite, V2FinanceExchangeCalculation {
  id: string;
  journalId: string;
  sourceAccountName: string;
  targetAccountName: string;
  feeAmountCny: string;
  fxGainLossCny: string;
  status: V2FinanceJournalStatus;
  correctionOfId: string | null;
  createdAt: string;
}
export interface V2FinanceExchangeSummary {
  count: number;
  feeAmountCny: string;
  fxGainLossCny: string;
  currencies: Array<{
    currency: V2FinanceCurrency;
    sourceAmount: string;
    targetAmount: string;
    feeAmount: string;
  }>;
}
export interface V2FinanceExchangePage {
  items: V2FinanceExchange[];
  total: number;
  page: number;
  pageSize: number;
  summary: V2FinanceExchangeSummary;
}
export interface V2FinanceExchangeQuery {
  page?: number;
  pageSize?: number;
  currency?: V2FinanceCurrency;
  financeAccountId?: string;
  status?: V2FinanceJournalStatus;
  dateFrom?: string;
  dateTo?: string;
  keyword?: string;
  sort?: 'newest' | 'oldest';
}
export function calculateFinanceExchange(
  input: Pick<V2FinanceExchangeWrite, 'sourceAmount' | 'targetAmount' | 'feeAmount' | 'feeMode'>
): V2FinanceExchangeCalculation {
  for (const key of ['sourceAmount', 'targetAmount', 'feeAmount'] as const) {
    const value = input[key];
    if (!isV2UnsignedDecimal(value) || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value))
      throw new Error('换汇金额必须为最多四位小数的非负数');
  }
  if (
    input.sourceAmount.replace(/[.0]/g, '') === '' ||
    input.targetAmount.replace(/[.0]/g, '') === ''
  )
    throw new Error('换汇本金和实际到账必须大于零');
  if (!['source_extra', 'target_deducted'].includes(input.feeMode))
    throw new Error('手续费扣法不正确');
  const totalDebit =
    input.feeMode === 'source_extra'
      ? addDecimalStrings(input.sourceAmount, input.feeAmount)
      : input.sourceAmount;
  const grossTargetAmount =
    input.feeMode === 'target_deducted'
      ? addDecimalStrings(input.targetAmount, input.feeAmount)
      : input.targetAmount;
  for (const value of [totalDebit, grossTargetAmount])
    if (!/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(value))
      throw new Error('换汇金额超过可保存范围');
  const denominator = input.feeMode === 'source_extra' ? input.sourceAmount : grossTargetAmount;
  return {
    totalDebit,
    grossTargetAmount,
    feePercent: divideDecimalStrings(
      multiplyDecimalStrings(input.feeAmount, '100', 8),
      denominator,
      8
    ),
    exchangeRate: divideDecimalStrings(grossTargetAmount, input.sourceAmount, 8),
    effectiveRate: divideDecimalStrings(input.targetAmount, totalDebit, 8),
    reverseRate: divideDecimalStrings(input.sourceAmount, grossTargetAmount, 8)
  };
}
