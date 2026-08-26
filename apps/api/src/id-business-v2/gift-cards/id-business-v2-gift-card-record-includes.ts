import type { Amount4, Rate8 } from '../runtime/public-api';

export type IdBusinessV2GiftCardStatus = 'credited' | 'redeemed' | 'withdrawn';
export type IdBusinessV2BalanceLedgerEntryType =
  | 'gift_card_credit'
  | 'gift_card_redeemed'
  | 'gift_card_withdrawal'
  | 'order_consumption'
  | 'order_consumption_reversal'
  | 'order_upgrade_balance_return'
  | 'order_upgrade_balance_return_reversal'
  | 'opening_balance'
  | 'manual_adjustment'
  | 'account_loss';

export interface OptionSummary {
  id: string;
  code: string;
  name: string;
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string | null;
}

export interface GiftCardRecord {
  id: string;
  cardNameOptionId: string;
  cardNameSnapshot: string;
  cardNameOption: OptionSummary;
  accountId: string;
  supplierOptionId: string | null;
  supplierOption: OptionSummary | null;
  sourceAttachmentId: string | null;
  codeEncrypted: string;
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
  purchaseCurrency: string;
  purchaseFxRateToCny: Rate8;
  purchaseFxSnapshotId: string | null;
  purchaseFinanceAccountId: string | null;
  purchaseSupplierAccountId: string | null;
  paidAt: Date | null;
  creditedAt: Date | null;
  supplierRefundStatus: string;
  supplierRefundAmount: Amount4;
  supplierRefundAmountCny: Amount4;
  supplierRefundClosedAt: Date | null;
  status: IdBusinessV2GiftCardStatus;
  statusChangedAt: Date;
  supplierNameSnapshot: string | null;
  countryOptionId: string;
  countryNameSnapshot: string;
  currencyCodeSnapshot: string | null;
  countryOption: { id: string; code: string };
  account: {
    id: string;
    appleIdEncrypted: string;
    appleIdMasked: string;
    lossReportedAt: Date | null;
    countryOption: OptionSummary;
  };
  ledgerEntries: Array<{
    id: string;
    balanceBefore: Amount4;
    balanceAfter: Amount4;
    costBefore: Amount4;
    costAfter: Amount4;
    averageCostBefore: Rate8;
    averageCostAfter: Rate8;
    createdAt: Date;
    reversedByEntry: {
      id: string;
      entryType: IdBusinessV2BalanceLedgerEntryType;
      balanceAmount: Amount4;
      costAmount: Amount4;
      remark: string | null;
      createdAt: Date;
    } | null;
  }>;
  supplierFundEntries: Array<{ id: string }>;
  remark: string | null;
  createdBy: UserSummary | null;
  updatedBy: UserSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceLedgerRecord {
  id: string;
  entryType: IdBusinessV2BalanceLedgerEntryType;
  direction: string;
  balanceAmount: Amount4;
  costAmount: Amount4;
  balanceBefore: Amount4;
  balanceAfter: Amount4;
  costBefore: Amount4;
  costAfter: Amount4;
  averageCostBefore: Rate8;
  averageCostAfter: Rate8;
  remark: string | null;
  account: {
    id: string;
    appleIdEncrypted: string;
    appleIdMasked: string;
    countryOption: OptionSummary;
  };
  giftCard: {
    id: string;
    codeEncrypted: string;
    codeMasked: string;
    codeTail: string;
    faceValue: Amount4;
    status: IdBusinessV2GiftCardStatus;
    supplierOption: OptionSummary | null;
  } | null;
  reversalOfEntry: {
    id: string;
    entryType: IdBusinessV2BalanceLedgerEntryType;
    createdAt: Date;
  } | null;
  reversedByEntry: {
    id: string;
    entryType: IdBusinessV2BalanceLedgerEntryType;
    createdAt: Date;
  } | null;
  createdBy: UserSummary | null;
  createdAt: Date;
}
