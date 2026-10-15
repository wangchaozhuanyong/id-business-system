import { toV2DateTimeInput } from '@/v2/utils/dateTime';
import type { BankRechargeOrder, RechargeOrderChannel } from './bank-recharge-api';

export function emptyForm() {
  return {
    plan: 'plus',
    chargeCurrencyCode: 'PHP',
    chargeAmount: '',
    manualEvidenceRef: '',
    paymentEvidenceRef: '',
    accountId: '',
    customerId: '',
    cardId: '',
    confirmFeeConversion: false,
    usdtFeeAmount: '',
    usdtFeeCurrencyCode: 'USDT',
    usdtFeeFinanceAccountId: '',
    usdtFeeFxRateToCny: '',
    usdtFeeManualRateReason: '',
    shoppingFeeAmount: '',
    shoppingFeeCurrencyCode: 'CNY',
    shoppingFeeFinanceAccountId: '',
    shoppingFeeFxRateToCny: '',
    shoppingFeeManualRateReason: '',
    customerFeeRate: '0',
    feeOverride: false,
    customerFeeAmount: '',
    bankFeeAmount: '0',
    bankFeeCurrencyCode: 'PHP',
    receivedAmount: '',
    receivedCurrencyCode: 'CNY',
    chargeFxRateToCny: '',
    bankFeeFxRateToCny: '',
    receivedFxRateToCny: '',
    fundingFinanceAccountId: '',
    receivedFinanceAccountId: '',
    openedAt: '',
    dueAt: '',
    remark: ''
  };
}

export function emptyRefundForm() {
  return {
    reason: '',
    refundReference: '',
    customerRefundAmount: '',
    chargeRecoveryAmountCny: '0',
    bankFeeRecoveryAmountCny: '0',
    usdtFeeRecoveryAmount: '0',
    shoppingFeeRecoveryAmount: '0',
    upstreamRefundReference: ''
  };
}

export function orderFormInitial(row: BankRechargeOrder, channel: RechargeOrderChannel) {
  return {
    plan: row.plan,
    chargeCurrencyCode: row.chargeCurrencyCode ?? '',
    chargeAmount: row.chargeAmount ?? '',
    manualEvidenceRef: row.manualEvidenceRef ?? '',
    accountId: row.accountId ?? '',
    customerId: row.customerId ?? '',
    cardId: (channel === 'online' ? row.onlineRechargeCardId : row.cardId) ?? '',
    confirmFeeConversion: false,
    usdtFeeAmount: row.usdtFeeAmount ?? '',
    usdtFeeCurrencyCode: row.usdtFeeCurrencyCode ?? 'USDT',
    usdtFeeFinanceAccountId: row.usdtFeeFinanceAccountId ?? '',
    usdtFeeFxRateToCny: row.usdtFeeFxRateToCny ?? '',
    usdtFeeManualRateReason: '',
    shoppingFeeAmount: row.shoppingFeeAmount ?? '',
    shoppingFeeCurrencyCode: row.shoppingFeeCurrencyCode ?? 'CNY',
    shoppingFeeFinanceAccountId: row.shoppingFeeFinanceAccountId ?? '',
    shoppingFeeFxRateToCny: row.shoppingFeeFxRateToCny ?? '',
    shoppingFeeManualRateReason: '',
    customerFeeRate: row.customerFeeRate,
    feeOverride: row.customerFeeOverridden,
    customerFeeAmount: row.customerFeeOverridden ? row.customerFeeAmount : '',
    bankFeeAmount: row.bankFeeAmount ?? '0',
    bankFeeCurrencyCode: row.bankFeeCurrencyCode ?? row.chargeCurrencyCode ?? '',
    receivedAmount: row.receivedAmount ?? '',
    receivedCurrencyCode: row.receivedCurrencyCode ?? 'CNY',
    chargeFxRateToCny: row.chargeFxRateToCny ?? '',
    bankFeeFxRateToCny: row.bankFeeFxRateToCny ?? '',
    receivedFxRateToCny: row.receivedFxRateToCny ?? '',
    fundingFinanceAccountId: row.fundingFinanceAccountId ?? '',
    receivedFinanceAccountId: row.receivedFinanceAccountId ?? '',
    openedAt: row.openedAt ? toV2DateTimeInput(row.openedAt) : '',
    dueAt: row.dueAt ? toV2DateTimeInput(row.dueAt) : '',
    remark: row.remark ?? ''
  };
}
