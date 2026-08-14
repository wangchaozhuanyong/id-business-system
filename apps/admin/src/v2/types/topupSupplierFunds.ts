import type { PaginatedResult, V2PageQuery } from '@apple-business/shared';

export interface V2TopupSupplierFundSelector {
  id: string;
  code: string;
  name: string;
  initialized: boolean;
  currentBalanceCny: string | null;
  isNegative: boolean;
}

export interface V2TopupSupplierFundItem {
  supplier: {
    id: string;
    code: string;
    name: string;
    status: 'active' | 'disabled';
  };
  accountId: string | null;
  initialized: boolean;
  initializedAt: string | null;
  currentBalanceCny: string | null;
  isNegative: boolean;
  paymentsCny: string;
  topupDeductionsCny: string;
  netAdjustmentsCny: string;
  lastPaymentAt: string | null;
  lastTopupAt: string | null;
  updatedAt: string;
}

export interface V2TopupSupplierFundSummary {
  totalBalanceCny: string;
  initializedCount: number;
  uninitializedCount: number;
  negativeCount: number;
}

export interface V2TopupSupplierFundListResult extends PaginatedResult<V2TopupSupplierFundItem> {
  summary: V2TopupSupplierFundSummary;
}

export interface V2TopupSupplierFundListQuery extends V2PageQuery {
  keyword?: string;
  status?: 'active' | 'disabled';
  fundingStatus?: 'initialized' | 'uninitialized' | 'negative';
  sortBy?: 'name' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export type V2TopupSupplierLedgerEntryType =
  | 'opening_balance'
  | 'payment_credit'
  | 'gift_card_debit'
  | 'id_purchase_debit'
  | 'gift_card_withdrawal_reversal'
  | 'manual_adjustment'
  | 'payment_reversal';

export interface V2TopupSupplierLedgerItem {
  id: string;
  entryType: V2TopupSupplierLedgerEntryType;
  direction: 'credit' | 'debit' | 'adjustment';
  amountCny: string;
  balanceDeltaCny: string;
  balanceBeforeCny: string;
  balanceAfterCny: string;
  reason: string | null;
  payment: {
    id: string;
    receivedUsdt: string;
    settlementRateCnyUsdt: string;
    paidAt: string;
  } | null;
  giftCard: {
    id: string;
    code: string | null;
    codeMasked: string;
    faceValue: string;
    exchangeRate: string;
    countryNameSnapshot: string;
    currencyCodeSnapshot: string | null;
  } | null;
  reversalOf: { id: string; entryType: V2TopupSupplierLedgerEntryType } | null;
  reversedBy: {
    id: string;
    entryType: V2TopupSupplierLedgerEntryType;
    createdAt: string;
  } | null;
  operator: {
    id: string;
    username: string;
    displayName: string;
  } | null;
  createdAt: string;
}

export interface V2TopupSupplierLedgerResult extends PaginatedResult<V2TopupSupplierLedgerItem> {
  supplier: { id: string; code: string; name: string };
  account: {
    id: string;
    initialized: boolean;
    initializedAt: string | null;
    currentBalanceCny: string;
    isNegative: boolean;
  } | null;
  countryStats: Array<{
    countryOptionId: string;
    countryName: string;
    currencyCode: string | null;
    cardCount: number;
    faceValue: string;
    costCny: string;
  }>;
}

export interface V2TopupSupplierLedgerQuery extends V2PageQuery {
  entryType?: V2TopupSupplierLedgerEntryType;
  dateFrom?: string;
  dateTo?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface V2TopupSupplierPaymentItem {
  id: string;
  supplier: { id: string; code: string; name: string };
  supplierNameSnapshot: string;
  receivedUsdt: string;
  networkFeeUsdt: string;
  settlementRateCnyUsdt: string;
  creditedCny: string;
  network: string | null;
  transactionHash: string | null;
  paidAt: string;
  postedAt: string;
  remark: string | null;
  status: 'active' | 'reversed';
  balanceBeforeCny: string | null;
  balanceAfterCny: string | null;
  reversal: { id: string; reason: string | null; createdAt: string } | null;
  operator: {
    id: string;
    username: string;
    displayName: string;
  } | null;
}

export interface V2TopupSupplierPaymentListResult extends PaginatedResult<V2TopupSupplierPaymentItem> {
  summary: {
    activeReceivedUsdt: string;
    activeNetworkFeeUsdt: string;
    activeCreditedCny: string;
    weightedAverageRate: string | null;
  };
}

export interface V2TopupSupplierPaymentListQuery extends V2PageQuery {
  keyword?: string;
  supplierOptionId?: string;
  status?: 'active' | 'reversed';
  dateFrom?: string;
  dateTo?: string;
  sortBy?: 'receivedUsdt' | 'settlementRateCnyUsdt' | 'creditedCny' | 'paidAt' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export interface V2TopupSupplierFundMutationResult {
  supplier: { id: string; name: string };
  ledgerEntry: {
    id: string;
    entryType: V2TopupSupplierLedgerEntryType;
    amountCny: string;
    balanceBeforeCny: string;
    balanceAfterCny: string;
    isNegative: boolean;
    createdAt: string;
  };
  idempotentReplay: boolean;
}

export interface V2TopupSupplierPaymentMutationResult {
  payment: {
    id: string;
    supplier: { id: string; name: string };
    receivedUsdt: string;
    networkFeeUsdt: string;
    settlementRateCnyUsdt: string;
    creditedCny: string;
    paidAt: string;
    createdAt: string;
  };
  ledgerEntry: {
    id: string;
    balanceBeforeCny: string;
    balanceAfterCny: string;
    isNegative: boolean;
    createdAt: string;
  };
  idempotentReplay: boolean;
}
