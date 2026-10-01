export function bankRechargeOrderAuditSnapshot(order: {
  customerId: string | null;
  accountId: string | null;
  cardId: string | null;
  chargeAmount: { toString(): string };
  chargeCurrencyCode: string;
  accountingVersion?: string;
  usdtFeeAmount?: { toString(): string } | null;
  shoppingFeeAmount?: { toString(): string } | null;
  usdtFeeCurrencyCode?: string | null;
  shoppingFeeCurrencyCode?: string | null;
  usdtFeeFinanceAccountId?: string | null;
  usdtFeeFxSnapshotId?: string | null;
  usdtFeeFxRateToCny?: { toString(): string } | null;
  usdtFeeAmountCny?: { toString(): string } | null;
  shoppingFeeFinanceAccountId?: string | null;
  shoppingFeeFxSnapshotId?: string | null;
  shoppingFeeFxRateToCny?: { toString(): string } | null;
  shoppingFeeAmountCny?: { toString(): string } | null;
  profitAmountCny?: { toString(): string } | null;
  customerFeeRate: { toString(): string };
  customerFeeAmount: { toString(): string };
  bankFeeAmount: { toString(): string } | null;
  receivedAmount: { toString(): string } | null;
  openedAt: Date | null;
  dueAt: Date | null;
}) {
  return {
    customerId: order.customerId,
    accountId: order.accountId,
    cardId: order.cardId,
    chargeAmount: order.chargeAmount.toString(),
    chargeCurrencyCode: order.chargeCurrencyCode,
    accountingVersion: order.accountingVersion ?? 'legacy',
    usdtFeeAmount: order.usdtFeeAmount?.toString() ?? null,
    shoppingFeeAmount: order.shoppingFeeAmount?.toString() ?? null,
    usdtFeeCurrencyCode: order.usdtFeeCurrencyCode ?? null,
    shoppingFeeCurrencyCode: order.shoppingFeeCurrencyCode ?? null,
    usdtFeeFinanceAccountId: order.usdtFeeFinanceAccountId ?? null,
    usdtFeeFxSnapshotId: order.usdtFeeFxSnapshotId ?? null,
    usdtFeeFxRateToCny: order.usdtFeeFxRateToCny?.toString() ?? null,
    usdtFeeAmountCny: order.usdtFeeAmountCny?.toString() ?? null,
    shoppingFeeFinanceAccountId: order.shoppingFeeFinanceAccountId ?? null,
    shoppingFeeFxSnapshotId: order.shoppingFeeFxSnapshotId ?? null,
    shoppingFeeFxRateToCny: order.shoppingFeeFxRateToCny?.toString() ?? null,
    shoppingFeeAmountCny: order.shoppingFeeAmountCny?.toString() ?? null,
    profitAmountCny: order.profitAmountCny?.toString() ?? null,
    customerFeeRate: order.customerFeeRate.toString(),
    customerFeeAmount: order.customerFeeAmount.toString(),
    bankFeeAmount: order.bankFeeAmount?.toString() ?? null,
    receivedAmount: order.receivedAmount?.toString() ?? null,
    openedAt: order.openedAt?.toISOString() ?? null,
    dueAt: order.dueAt?.toISOString() ?? null
  };
}
