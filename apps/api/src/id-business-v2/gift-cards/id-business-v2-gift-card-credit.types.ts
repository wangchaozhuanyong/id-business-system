import type { Amount4, Rate8, V2CommandTransaction } from '../runtime/public-api';

export interface LockedGiftCardCreditAccountRow {
  id: string;
  appleIdMasked: string;
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  soldByOrderId: string | null;
  lossReportedAt: Date | null;
  countryOptionId: string;
  countryName: string;
  currencyCode: string | null;
}

export interface GiftCardCreditRecord {
  id: string;
  accountId: string;
  cardNameOptionId: string;
  cardNameSnapshot: string;
  countryOptionId: string;
  supplierOptionId: string | null;
  sourceAttachmentId: string | null;
  codeHash: string;
  codeMasked: string;
  codeTail: string;
  faceValue: Amount4;
  exchangeRate: Rate8;
  exchangeRateSource: string;
  exchangeRateSnapshotId: string | null;
  exchangeRatePrefilledValue: Rate8 | null;
  exchangeRateWasOverridden: boolean;
  costAmount: Amount4;
  purchaseOriginalAmount: Amount4;
  purchaseCurrency: 'CNY' | 'MYR' | 'USDT';
  purchaseFxRateToCny: Rate8;
  purchaseFxSnapshotId: string | null;
  purchaseFinanceAccountId: string | null;
  purchaseSupplierAccountId: string | null;
  paidAt: Date | null;
  creditedAt: Date | null;
  status: string;
  statusChangedAt: Date;
  remark: string | null;
  createdAt: Date;
}

export interface GiftCardCreditLedgerRecord {
  id: string;
  accountId: string;
  giftCardId: string | null;
  orderId: string | null;
  entryType: string;
  direction: string;
  balanceAmount: Amount4;
  costAmount: Amount4;
  balanceBefore: Amount4;
  balanceAfter: Amount4;
  costBefore: Amount4;
  costAfter: Amount4;
  averageCostBefore: Rate8;
  averageCostAfter: Rate8;
  reversalOfEntryId: string | null;
  idempotencyKey: string;
  remark: string | null;
  createdAt: Date;
}

export interface GiftCardCreditAccountRecord {
  id: string;
  appleIdMasked: string;
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
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
  tx: V2CommandTransaction;
  accountId: string;
  giftCardId: string;
  ledgerEntryId: string;
  idempotentReplay: boolean;
}

export type CreditTransactionHook = (context: CreditTransactionHookContext) => Promise<void>;
