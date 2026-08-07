import type { DecimalString, IsoDateTimeString, PaginatedResult } from './common.js';

export const V2_FINANCE_CURRENCIES = ['CNY', 'MYR', 'USDT'] as const;
export type V2FinanceCurrency = (typeof V2_FINANCE_CURRENCIES)[number];

export const V2_FINANCE_ACCOUNT_TYPES = ['bank', 'cash', 'ewallet', 'usdt_wallet'] as const;
export type V2FinanceAccountType = (typeof V2_FINANCE_ACCOUNT_TYPES)[number];

export type V2FinanceAccountStatus = 'active' | 'disabled';
export type V2FinancePeriodStatus = 'open' | 'closed' | 'reopened';
export type V2FinanceJournalStatus = 'posted' | 'reversed';
export type V2FinanceLineDirection = 'debit' | 'credit';
export type V2FinanceHistoryStatus = 'not_started' | 'in_progress' | 'incomplete' | 'completed';

export type V2FinanceJournalType =
  | 'supplier_deposit'
  | 'supplier_refund'
  | 'supplier_adjustment'
  | 'gift_card_purchase'
  | 'gift_card_redemption_loss'
  | 'gift_card_withdrawal_pending'
  | 'gift_card_refund_received'
  | 'gift_card_refund_write_off'
  | 'account_purchase'
  | 'order_completed'
  | 'order_refund'
  | 'order_cancel'
  | 'order_recovery'
  | 'account_loss'
  | 'expense'
  | 'opening_balance'
  | 'fx_gain_loss'
  | 'manual_adjustment'
  | 'historical_backfill'
  | 'reversal';

export type V2FinanceAccountCode =
  | 'cash'
  | 'supplier_prepayment'
  | 'supplier_refund_receivable'
  | 'gift_card_inventory'
  | 'id_inventory'
  | 'sales_revenue'
  | 'platform_fee'
  | 'gift_card_cost'
  | 'id_cost'
  | 'refund_loss'
  | 'gift_card_redemption_loss'
  | 'balance_loss'
  | 'id_purchase_loss'
  | 'operating_expense'
  | 'realized_fx_gain_loss'
  | 'opening_equity'
  | 'manual_adjustment';

export interface V2FinanceSettings {
  baseCurrency: 'CNY';
  timezone: 'Asia/Kuala_Lumpur';
  enabledAt: IsoDateTimeString | null;
  historyStatus: V2FinanceHistoryStatus;
  historyCompletedAt: IsoDateTimeString | null;
  historyNote: string | null;
}

export interface V2FinanceAccount {
  id: string;
  name: string;
  accountType: V2FinanceAccountType;
  currency: V2FinanceCurrency;
  openingBalance: DecimalString;
  currentBalance: DecimalString;
  openingBalanceCny: DecimalString;
  currentBalanceCny: DecimalString;
  status: V2FinanceAccountStatus;
  remark: string | null;
  createdAt: IsoDateTimeString;
  updatedAt: IsoDateTimeString;
}

export interface V2FinanceFxRateSnapshot {
  id: string;
  currency: V2FinanceCurrency;
  rateToCny: DecimalString;
  source:
    | 'cny_fixed'
    | 'combined_p2p'
    | 'binance'
    | 'okx'
    | 'ecb_cross'
    | 'manual'
    | 'legacy_assumed_cny'
    | 'opening_balance';
  sourceReference: string | null;
  businessDate: string;
  capturedAt: IsoDateTimeString;
  expiresAt: IsoDateTimeString | null;
  manualReason: string | null;
}

export interface V2FinanceLatestRate {
  id: string | null;
  currency: V2FinanceCurrency;
  rateToCny: DecimalString | null;
  source: V2FinanceFxRateSnapshot['source'] | null;
  capturedAt: IsoDateTimeString | null;
  expiresAt: IsoDateTimeString | null;
}

export interface V2OrderReceiptFxQuote {
  snapshotId: string | null;
  currency: V2FinanceCurrency;
  rateToCny: DecimalString;
  source: V2FinanceFxRateSnapshot['source'];
  capturedAt: IsoDateTimeString;
  expiresAt: IsoDateTimeString | null;
}

export interface V2FinanceJournalLine {
  id: string;
  lineNo: number;
  accountCode: V2FinanceAccountCode;
  direction: V2FinanceLineDirection;
  currency: V2FinanceCurrency;
  amountOriginal: DecimalString;
  fxRateToCny: DecimalString;
  amountCny: DecimalString;
  financeAccountId: string | null;
  supplierAccountId: string | null;
  memo: string | null;
}

export interface V2FinanceJournal {
  id: string;
  journalNo: string;
  journalType: V2FinanceJournalType;
  sourceType: string;
  sourceId: string | null;
  sourceReference: string | null;
  businessDate: string;
  periodMonth: string;
  occurredAt: IsoDateTimeString;
  status: V2FinanceJournalStatus;
  reversalOfJournalId: string | null;
  reversedAt: IsoDateTimeString | null;
  summary: string;
  lines: V2FinanceJournalLine[];
}

export interface V2FinanceExpense {
  id: string;
  journalId: string;
  categoryOptionId: string;
  categoryName: string;
  financeAccountId: string;
  financeAccountName: string;
  currency: V2FinanceCurrency;
  amountOriginal: DecimalString;
  fxRateToCny: DecimalString;
  amountCny: DecimalString;
  occurredAt: IsoDateTimeString;
  payee: string | null;
  receiptAttachmentId: string | null;
  remark: string | null;
  createdBy: { id: string; username: string; displayName: string } | null;
  createdAt: IsoDateTimeString;
}

export interface V2FinanceSupplierWallet {
  id: string;
  supplierOptionId: string;
  supplierName: string;
  currency: V2FinanceCurrency;
  openingBalance: DecimalString;
  currentBalance: DecimalString;
  openingBalanceCny: DecimalString;
  currentBalanceCny: DecimalString;
  status: V2FinanceAccountStatus;
  initializedAt: IsoDateTimeString | null;
  updatedAt: IsoDateTimeString;
}

export interface V2FinanceSupplierLedgerEntry {
  id: string;
  supplierAccountId: string;
  entryType: string;
  direction: 'credit' | 'debit' | 'adjustment';
  currency: V2FinanceCurrency;
  amount: DecimalString;
  balanceBefore: DecimalString;
  balanceAfter: DecimalString;
  amountCny: DecimalString;
  balanceBeforeCny: DecimalString;
  balanceAfterCny: DecimalString;
  reason: string | null;
  createdAt: IsoDateTimeString;
}

export interface V2FinancePeriod {
  month: string;
  status: V2FinancePeriodStatus;
  closedAt: IsoDateTimeString | null;
  reopenReason: string | null;
  reopenedAt: IsoDateTimeString | null;
  updatedAt: IsoDateTimeString;
}

export interface V2FinanceHistoryBackfillResult {
  enabledAt: IsoDateTimeString;
  historyStatus: 'incomplete';
  historyNote: string;
  summary: {
    orders: number;
    accountLosses: number;
    redeemedGiftCards: number;
    withdrawnGiftCards: number;
    assetOpeningCreated: boolean;
    skippedExisting: number;
  };
}

export interface V2FinanceHistoryBackfillPreviewCategory {
  candidateCount: number;
  willCreateCount: number;
  skippedExistingCount: number;
  skippedZeroAmountCount: number;
}

export interface V2FinanceHistoryBackfillPreview {
  previewedAt: IsoDateTimeString;
  asOf: IsoDateTimeString;
  historyStatus: V2FinanceHistoryStatus;
  canBackfill: boolean;
  assumption: 'legacy_assumed_cny';
  fingerprint: string;
  summary: {
    orders: V2FinanceHistoryBackfillPreviewCategory;
    accountLosses: V2FinanceHistoryBackfillPreviewCategory;
    redeemedGiftCards: V2FinanceHistoryBackfillPreviewCategory;
    withdrawnGiftCards: V2FinanceHistoryBackfillPreviewCategory;
  };
  fxSnapshotUpdates: {
    accounts: number;
    giftCards: number;
    orders: number;
  };
  assetOpening: {
    willCreate: boolean;
    adjustmentTotalCny: DecimalString;
    journalLineCount: number;
    adjustments: Array<{
      accountCode:
        | 'gift_card_inventory'
        | 'id_inventory'
        | 'supplier_prepayment'
        | 'supplier_refund_receivable';
      direction: 'debit' | 'credit';
      amountCny: DecimalString;
    }>;
  };
}

export interface V2FinanceHistoryConfirmationPreview {
  generatedAt: IsoDateTimeString;
  enabledAt: IsoDateTimeString;
  historyStatus: V2FinanceHistoryStatus;
  canConfirm: boolean;
  fingerprint: string;
  financeAccounts: {
    count: number;
    openingBalanceCny: DecimalString;
    currentBalanceCny: DecimalString;
  };
  supplierWallets: {
    count: number;
    openingBalanceCny: DecimalString;
    currentBalanceCny: DecimalString;
  };
  historicalExpenses: {
    count: number;
    amountCny: DecimalString;
  };
}

export interface V2FinanceCurrencyBreakdown {
  currency: V2FinanceCurrency;
  income: DecimalString;
  expense: DecimalString;
  netCashFlow: DecimalString;
  latestRateToCny: DecimalString | null;
  netCashFlowCny: DecimalString | null;
}

export interface V2FinanceProfitLoss {
  salesRevenueCny: DecimalString;
  platformFeeCny: DecimalString;
  giftCardCostCny: DecimalString;
  idCostCny: DecimalString;
  refundLossCny: DecimalString;
  redemptionLossCny: DecimalString;
  balanceLossCny: DecimalString;
  idPurchaseLossCny: DecimalString;
  operatingExpenseCny: DecimalString;
  realizedFxGainLossCny: DecimalString;
  netProfitCny: DecimalString;
  estimatedProfitCny: DecimalString;
}

export interface V2FinanceAssetBreakdown {
  cashCny: DecimalString;
  supplierPrepaymentCny: DecimalString;
  giftCardInventoryCny: DecimalString;
  unsoldIdInventoryCny: DecimalString;
  supplierRefundReceivableCny: DecimalString;
  totalBookValueCny: DecimalString;
  totalLatestValuationCny: DecimalString | null;
  unrealizedFxChangeCny: DecimalString | null;
}

export interface V2FinanceReconciliationIssue {
  code:
    | 'history_incomplete'
    | 'missing_fx_rate'
    | 'stale_fx_rate'
    | 'order_profit_difference'
    | 'supplier_balance_difference'
    | 'open_supplier_refund'
    | 'missing_finance_journal';
  severity: 'info' | 'warning' | 'error';
  sourceType: string | null;
  sourceId: string | null;
  message: string;
  amountCny: DecimalString | null;
}

export interface V2SettlementPlatformOriginalAmount {
  currency: V2FinanceCurrency;
  grossReceived: DecimalString;
  refunded: DecimalString;
}

export interface V2SettlementPlatformReportRow {
  settlementPlatform: {
    id: string;
    name: string;
  } | null;
  completedOrderCount: number;
  originalAmounts: V2SettlementPlatformOriginalAmount[];
  grossReceivedCny: DecimalString;
  refundedCny: DecimalString;
  platformFeeCny: DecimalString;
  netSettlementCny: DecimalString;
  realizedProfitCny: DecimalString;
  realizedProfitRate: DecimalString | null;
  pendingOrderCount: number;
  pendingReceivedCny: DecimalString;
  pendingProfitCny: DecimalString;
}

export interface V2SettlementPlatformReport {
  options: Array<{
    id: string;
    name: string;
  }>;
  totals: Omit<V2SettlementPlatformReportRow, 'settlementPlatform'>;
  rows: V2SettlementPlatformReportRow[];
  hasHistoricalUnspecified: boolean;
  historicalUnspecifiedAmountCny: DecimalString;
}

export interface V2FinanceOverview {
  settings: V2FinanceSettings;
  profitLoss: V2FinanceProfitLoss;
  currencyBreakdown: V2FinanceCurrencyBreakdown[];
  assets: V2FinanceAssetBreakdown;
  settlementPlatformReport: V2SettlementPlatformReport;
  reconciliation: {
    isComplete: boolean;
    issueCount: number;
    issues: V2FinanceReconciliationIssue[];
  };
}

export type V2FinanceJournalPage = PaginatedResult<V2FinanceJournal>;
export type V2FinanceExpensePage = PaginatedResult<V2FinanceExpense>;
export type V2FinanceSupplierLedgerPage = PaginatedResult<V2FinanceSupplierLedgerEntry>;
