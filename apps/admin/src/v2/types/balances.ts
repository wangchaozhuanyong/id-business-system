import type { PaginatedResult, V2FinanceCurrency, V2PageQuery } from '@apple-business/shared';
import type { V2OptionSelector } from './options';
import type { ReportV2AccountLossResult } from './records';
import type { V2TopupSupplierFundSelector } from './topupSupplierFunds';

export type V2TopupBalancePreset = '' | 'zero' | 'positive_under_20' | 'custom';
export type V2TopupWorkbenchSortBy =
  | 'appleId'
  | 'currentBalance'
  | 'balanceCostAmount'
  | 'updatedAt';

export interface V2TopupServiceSummary {
  id: string;
  code: string;
  name: string;
  parent: {
    id: string;
    name: string;
  } | null;
}

export interface V2TopupWorkbenchItem {
  id: string;
  appleIdMasked: string;
  country: Pick<V2OptionSelector, 'id' | 'code' | 'name'>;
  currentBalance: string;
  balanceCostAmount: string;
  averageCost: string;
  topupRecordCount: number;
  balanceChangeCount: number;
  lastTopupAt: string | null;
  updatedAt: string;
  status: Pick<V2OptionSelector, 'id' | 'code' | 'name'> & { isSystem: boolean };
  historicalServices: V2TopupServiceSummary[];
  currentServices: V2TopupServiceSummary[];
  serviceDataAvailable: true;
}

export interface V2TopupWorkbenchListResult extends PaginatedResult<V2TopupWorkbenchItem> {
  evaluatedAt: string;
}

export interface V2GiftCardPurchaseSources {
  financeAccounts: Array<{
    id: string;
    name: string;
    currency: V2FinanceCurrency;
    currentBalance: string;
  }>;
  supplierWallets: Array<{
    id: string;
    supplierOptionId: string;
    supplierName: string;
    currency: V2FinanceCurrency;
    currentBalance: string;
  }>;
}

export interface V2TopupWorkbenchListQuery extends V2PageQuery {
  countryOptionId?: string;
  balancePreset?: Exclude<V2TopupBalancePreset, ''>;
  balanceMin?: string;
  balanceMax?: string;
  onlyNormal?: boolean;
  sortBy?: V2TopupWorkbenchSortBy;
  sortOrder?: 'asc' | 'desc';
}

export interface V2GiftCardCreditPayload {
  code: string;
  faceValue: string;
  exchangeRate?: string;
  exchangeRateSnapshotId?: string;
  exchangeRatePrefilledValue?: string;
  supplierOptionId: string;
  purchaseOriginalAmount: string;
  purchaseCurrency: V2FinanceCurrency;
  purchaseFxRateToCny?: string;
  purchaseFinanceAccountId?: string;
  purchaseSupplierAccountId?: string;
  purchaseManualRateReason?: string;
  paidAt: string;
  idempotencyKey: string;
  remark?: string;
}

export interface V2GiftCardCreditResult {
  giftCard: {
    id: string;
    codeMasked: string;
    codeTail: string;
    faceValue: string;
    exchangeRate: string;
    exchangeRateSource: 'manual_input' | 'automatic_snapshot' | 'system_derived_purchase_cost';
    exchangeRateSnapshotId: string | null;
    exchangeRatePrefilledValue: string | null;
    exchangeRateWasOverridden: boolean;
    costAmount: string;
    purchaseOriginalAmount: string;
    purchaseCurrency: V2FinanceCurrency;
    purchaseFxRateToCny: string;
    purchaseFxSnapshotId: string | null;
    purchaseFinanceAccountId: string | null;
    purchaseSupplierAccountId: string | null;
    paidAt: string | null;
    status: string;
    supplierOptionId: string | null;
    sourceAttachmentId: string | null;
    createdAt: string;
  };
  ledgerEntry: {
    id: string;
    balanceBefore: string;
    balanceAfter: string;
    costBefore: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
    createdAt: string;
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
    createdAt: string;
    idempotentReplay: boolean;
  } | null;
  idempotentReplay: boolean;
}

export type V2GiftCardReversalAction = 'redeemed' | 'withdrawn';

export interface V2ReversibleGiftCard {
  id: string;
  codeMasked: string;
  codeTail: string;
  faceValue: string;
  exchangeRate: string;
  exchangeRateSource: 'manual_input' | 'automatic_snapshot' | 'system_derived_purchase_cost';
  exchangeRateSnapshotId: string | null;
  exchangeRatePrefilledValue: string | null;
  exchangeRateWasOverridden: boolean;
  costAmount: string;
  status: 'credited';
  supplier: {
    id: string;
    name: string;
  } | null;
  creditedLedger: {
    id: string;
    balanceBefore: string;
    balanceAfter: string;
    createdAt: string;
  } | null;
  createdAt: string;
}

export interface V2ReversibleGiftCardListResult {
  account: {
    id: string;
    appleIdMasked: string;
  };
  items: V2ReversibleGiftCard[];
  total: number;
  limited: boolean;
}

export interface V2GiftCardReversalPayload {
  action: V2GiftCardReversalAction;
  reason: string;
  idempotencyKey: string;
  reportAccountLoss?: boolean;
}

export interface V2GiftCardReversalResult {
  action: V2GiftCardReversalAction;
  giftCard: {
    id: string;
    codeMasked: string;
    codeTail: string;
    faceValue: string;
    exchangeRate: string;
    originalCostAmount: string;
    status: V2GiftCardReversalAction;
    statusChangedAt: string;
  };
  ledgerEntry: {
    id: string;
    entryType: 'gift_card_redeemed' | 'gift_card_withdrawal';
    balanceAmount: string;
    costAmount: string;
    balanceBefore: string;
    balanceAfter: string;
    costBefore: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
    reversalOfEntryId: string;
    createdAt: string;
  };
  account: {
    id: string;
    appleIdMasked: string;
    currentBalance: string;
    balanceCostAmount: string;
  };
  accountLoss: ReportV2AccountLossResult | null;
  supplierFunding: {
    ledgerEntryId: string;
    amountCny: string;
    balanceBeforeCny: string;
    balanceAfterCny: string;
    isNegative: boolean;
  } | null;
  idempotentReplay: boolean;
}

export type V2GiftCardRecordStatus = 'credited' | 'redeemed' | 'withdrawn';
export type V2GiftCardRecordSortBy =
  | 'faceValue'
  | 'exchangeRate'
  | 'costAmount'
  | 'status'
  | 'statusChangedAt'
  | 'createdAt'
  | 'updatedAt';

export interface V2GiftCardRecord {
  id: string;
  code: string;
  codeMasked: string;
  codeTail: string;
  faceValue: string;
  exchangeRate: string;
  costAmount: string;
  purchaseOriginalAmount: string;
  purchaseCurrency: V2FinanceCurrency;
  purchaseFxRateToCny: string;
  purchaseFxSnapshotId: string | null;
  purchaseFinanceAccountId: string | null;
  purchaseSupplierAccountId: string | null;
  paidAt: string | null;
  supplierRefundStatus: 'none' | 'pending' | 'received' | 'written_off';
  supplierRefundAmount: string;
  supplierRefundAmountCny: string;
  supplierRefundClosedAt: string | null;
  status: V2GiftCardRecordStatus;
  statusChangedAt: string;
  supplierOptionId: string | null;
  supplier: Pick<V2OptionSelector, 'id' | 'code' | 'name'> | null;
  country: Pick<V2OptionSelector, 'id' | 'code' | 'name'> & {
    currencyCode: string | null;
  };
  account: {
    id: string;
    appleIdMasked: string;
    lossStatus: 'active' | 'reported';
    lossReportedAt: string | null;
    country: Pick<V2OptionSelector, 'id' | 'code' | 'name'>;
  };
  creditedLedger: {
    id: string;
    balanceBefore: string;
    balanceAfter: string;
    costBefore: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
    createdAt: string;
  } | null;
  supplierFunding: {
    ledgerEntryId: string;
    supplierName: string;
    amountCny: string;
    balanceBeforeCny: string;
    balanceAfterCny: string;
    reversed: boolean;
    createdAt: string;
  } | null;
  reversal: {
    id: string;
    entryType: 'gift_card_redeemed' | 'gift_card_withdrawal';
    balanceAmount: string;
    costAmount: string;
    reason: string | null;
    createdAt: string;
  } | null;
  remark: string | null;
  hasSourceAttachment: boolean;
  createdBy: V2BalanceOperator | null;
  updatedBy: V2BalanceOperator | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2GiftCardRecordListQuery extends V2PageQuery {
  keyword?: string;
  accountId?: string;
  countryOptionId?: string;
  supplierOptionId?: string;
  status?: V2GiftCardRecordStatus;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: V2GiftCardRecordSortBy;
  sortOrder?: 'asc' | 'desc';
}

export type V2GiftCardRecordListResult = PaginatedResult<V2GiftCardRecord>;

export interface V2GiftCardMetadataPayload {
  supplierOptionId?: string | null;
  remark?: string | null;
}

export type { V2TopupSupplierFundSelector };

export type V2BalanceLedgerEntryType =
  | 'gift_card_credit'
  | 'gift_card_redeemed'
  | 'gift_card_withdrawal'
  | 'order_consumption'
  | 'order_consumption_reversal'
  | 'opening_balance'
  | 'manual_adjustment'
  | 'account_loss';
export type V2BalanceLedgerSortBy =
  | 'balanceAmount'
  | 'costAmount'
  | 'balanceAfter'
  | 'costAfter'
  | 'createdAt';

export interface V2BalanceOperator {
  id: string;
  username: string;
  displayName: string;
}

export interface V2BalanceLedgerRecord {
  id: string;
  entryType: V2BalanceLedgerEntryType;
  direction: 'credit' | 'debit' | 'adjustment';
  balanceAmount: string;
  costAmount: string;
  balanceDelta: string;
  costDelta: string;
  balanceBefore: string;
  balanceAfter: string;
  costBefore: string;
  costAfter: string;
  averageCostBefore: string;
  averageCostAfter: string;
  reason: string | null;
  account: {
    id: string;
    appleIdMasked: string;
    country: Pick<V2OptionSelector, 'id' | 'code' | 'name'>;
  };
  giftCard: {
    id: string;
    code: string;
    codeMasked: string;
    codeTail: string;
    faceValue: string;
    status: V2GiftCardRecordStatus;
    supplier: Pick<V2OptionSelector, 'id' | 'code' | 'name'> | null;
  } | null;
  reversalOf: {
    id: string;
    entryType: V2BalanceLedgerEntryType;
    createdAt: string;
  } | null;
  reversedBy: {
    id: string;
    entryType: V2BalanceLedgerEntryType;
    createdAt: string;
  } | null;
  operator: V2BalanceOperator | null;
  createdAt: string;
}

export interface V2BalanceLedgerListQuery extends V2PageQuery {
  keyword?: string;
  accountId?: string;
  countryOptionId?: string;
  supplierOptionId?: string;
  entryType?: V2BalanceLedgerEntryType;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: V2BalanceLedgerSortBy;
  sortOrder?: 'asc' | 'desc';
}

export type V2BalanceLedgerListResult = PaginatedResult<V2BalanceLedgerRecord>;
