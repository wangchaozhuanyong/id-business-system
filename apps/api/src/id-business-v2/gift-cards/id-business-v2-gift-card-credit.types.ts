import type { Prisma } from '@prisma/client';

export interface LockedGiftCardCreditAccountRow {
  id: string;
  appleIdMasked: string;
  currentBalance: Prisma.Decimal;
  balanceCostAmount: Prisma.Decimal;
  soldByOrderId: string | null;
  lossReportedAt: Date | null;
  countryOptionId: string;
  countryName: string;
  currencyCode: string | null;
}

export interface CreditResponse {
  giftCard: {
    id: string;
    cardNameOptionId: string;
    cardName: string;
    countryOptionId: string;
    codeMasked: string;
    codeTail: string;
    faceValue: string;
    exchangeRate: string;
    exchangeRateSource: string;
    exchangeRateSnapshotId: string | null;
    exchangeRatePrefilledValue: string | null;
    exchangeRateWasOverridden: boolean;
    costAmount: string;
    purchaseOriginalAmount: string;
    purchaseCurrency: 'CNY' | 'MYR' | 'USDT';
    purchaseFxRateToCny: string;
    purchaseFxSnapshotId: string | null;
    purchaseFinanceAccountId: string | null;
    purchaseSupplierAccountId: string | null;
    paidAt: Date | null;
    creditedAt: Date;
    status: string;
    supplierOptionId: string | null;
    sourceAttachmentId: string | null;
    createdAt: Date;
  };
  ledgerEntry: {
    id: string;
    balanceBefore: string;
    balanceAfter: string;
    costBefore: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
    createdAt: Date;
  };
  account: {
    id: string;
    appleIdMasked: string;
    currentBalance: string;
    balanceCostAmount: string;
  };
  supplierFunding: {
    ledgerEntryId: string;
    supplierAccountId: string;
    supplierName: string;
    amountCny: string;
    balanceBeforeCny: string;
    balanceAfterCny: string;
    isNegative: boolean;
    shortfallCny: string;
    createdAt: Date;
    idempotentReplay: boolean;
  } | null;
  idempotentReplay: boolean;
}

export interface CreditAuditContext {
  source: 'renewal_workbench';
  activationId: string;
  orderId: string;
  orderNo: string;
}

export interface CreditTransactionHookContext {
  tx: Prisma.TransactionClient;
  accountId: string;
  giftCardId: string;
  ledgerEntryId: string;
  idempotentReplay: boolean;
}

export type CreditTransactionHook = (context: CreditTransactionHookContext) => Promise<void>;
