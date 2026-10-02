export function emptyForm() {
  return {
    plan: 'plus',
    chargeCurrencyCode: 'PHP',
    chargeAmount: '',
    manualEvidenceRef: '',
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
