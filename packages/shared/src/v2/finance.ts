import type { DecimalString, IsoDateTimeString, PaginatedResult } from './common.js';
import { isV2OrderReceiptCurrency, type V2OrderReceiptCurrency } from './order-receipt.js';

export const V2_FINANCE_CURRENCIES = [
  'CNY',
  'MYR',
  'USD',
  'PHP',
  'IDR',
  'CLP',
  'JPY',
  'KRW',
  'TWD',
  'HKD',
  'SGD',
  'EUR',
  'GBP',
  'AUD',
  'CAD',
  'CHF',
  'NZD',
  'THB',
  'VND',
  'INR',
  'AED',
  'SAR',
  'BRL',
  'MXN',
  'ZAR',
  'USDT'
] as const;
export const V2_FINANCE_CURRENCY_OPTIONS = [
  { code: 'CNY', name: '人民币', minorUnits: 2, label: '人民币（CNY）' },
  { code: 'MYR', name: '马币', minorUnits: 2, label: '马币（MYR）' },
  { code: 'USD', name: '美元', minorUnits: 2, label: '美元（USD）' },
  { code: 'PHP', name: '菲律宾比索', minorUnits: 2, label: '菲律宾比索（PHP）' },
  { code: 'IDR', name: '印尼盾', minorUnits: 2, label: '印尼盾（IDR）' },
  { code: 'CLP', name: '智利比索', minorUnits: 0, label: '智利比索（CLP）' },
  { code: 'JPY', name: '日元', minorUnits: 0, label: '日元（JPY）' },
  { code: 'KRW', name: '韩元', minorUnits: 0, label: '韩元（KRW）' },
  { code: 'TWD', name: '新台币', minorUnits: 2, label: '新台币（TWD）' },
  { code: 'HKD', name: '港币', minorUnits: 2, label: '港币（HKD）' },
  { code: 'SGD', name: '新加坡元', minorUnits: 2, label: '新加坡元（SGD）' },
  { code: 'EUR', name: '欧元', minorUnits: 2, label: '欧元（EUR）' },
  { code: 'GBP', name: '英镑', minorUnits: 2, label: '英镑（GBP）' },
  { code: 'AUD', name: '澳元', minorUnits: 2, label: '澳元（AUD）' },
  { code: 'CAD', name: '加拿大元', minorUnits: 2, label: '加拿大元（CAD）' },
  { code: 'CHF', name: '瑞士法郎', minorUnits: 2, label: '瑞士法郎（CHF）' },
  { code: 'NZD', name: '新西兰元', minorUnits: 2, label: '新西兰元（NZD）' },
  { code: 'THB', name: '泰铢', minorUnits: 2, label: '泰铢（THB）' },
  { code: 'VND', name: '越南盾', minorUnits: 0, label: '越南盾（VND）' },
  { code: 'INR', name: '印度卢比', minorUnits: 2, label: '印度卢比（INR）' },
  { code: 'AED', name: '阿联酋迪拉姆', minorUnits: 2, label: '阿联酋迪拉姆（AED）' },
  { code: 'SAR', name: '沙特里亚尔', minorUnits: 2, label: '沙特里亚尔（SAR）' },
  { code: 'BRL', name: '巴西雷亚尔', minorUnits: 2, label: '巴西雷亚尔（BRL）' },
  { code: 'MXN', name: '墨西哥比索', minorUnits: 2, label: '墨西哥比索（MXN）' },
  { code: 'ZAR', name: '南非兰特', minorUnits: 2, label: '南非兰特（ZAR）' },
  { code: 'USDT', name: '泰达币', minorUnits: 4, label: '泰达币（USDT）' }
] as const;
export function financeCurrencyLabel(currency: string) {
  return V2_FINANCE_CURRENCY_OPTIONS.find((item) => item.code === currency)?.label ?? currency;
}

export type V2FinanceCurrency = (typeof V2_FINANCE_CURRENCIES)[number];

export const V2_FINANCE_ACCOUNT_TYPES = ['bank', 'cash', 'ewallet', 'usdt_wallet'] as const;
export type V2FinanceAccountType = (typeof V2_FINANCE_ACCOUNT_TYPES)[number];

export type V2FinanceAccountStatus = 'active' | 'disabled';
export type V2FinancePeriodStatus = 'open' | 'closed' | 'reopened';
export type V2FinanceJournalStatus = 'posted' | 'reversed';
export type V2FinanceLineDirection = 'debit' | 'credit';
export type V2FinanceHistoryStatus = 'not_started' | 'in_progress' | 'incomplete' | 'completed';
export type V2FinanceInflowNature = 'operating_income' | 'capital_contribution' | 'borrowed_funds';

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
  | 'bank_recharge_completed'
  | 'order_refund'
  | 'order_upgrade_balance_return'
  | 'order_cancel'
  | 'order_recovery'
  | 'account_loss'
  | 'expense'
  | 'fx_exchange'
  | 'manual_operating_income'
  | 'capital_contribution'
  | 'borrowed_funds_received'
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
  | 'bank_recharge_revenue'
  | 'bank_recharge_service_fee'
  | 'bank_recharge_cost'
  | 'bank_recharge_bank_fee'
  | 'other_operating_revenue'
  | 'contributed_capital'
  | 'borrowed_funds_payable'
  | 'platform_fee'
  | 'gift_card_cost'
  | 'id_cost'
  | 'customer_owned_balance_cost'
  | 'refund_loss'
  | 'gift_card_redemption_loss'
  | 'balance_loss'
  | 'id_purchase_loss'
  | 'operating_expense'
  | 'fx_exchange_fee'
  | 'bank_recharge_usdt_fee'
  | 'bank_recharge_shopping_fee'
  | 'realized_fx_gain_loss'
  | 'opening_equity'
  | 'manual_adjustment';

export interface V2FinanceSettings {
  baseCurrency: 'CNY';
  timezone: 'Asia/Shanghai';
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
    | 'exchange_rate_api'
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
  status: V2FinanceJournalStatus;
  createdBy: { id: string; username: string; displayName: string } | null;
  createdAt: IsoDateTimeString;
}

export interface V2FinanceInflow {
  id: string;
  journalId: string;
  nature: V2FinanceInflowNature;
  categoryOptionId: string | null;
  categoryName: string | null;
  financeAccountId: string;
  financeAccountName: string;
  currency: V2FinanceCurrency;
  amountOriginal: DecimalString;
  fxRateToCny: DecimalString;
  amountCny: DecimalString;
  occurredAt: IsoDateTimeString;
  payer: string | null;
  externalReference: string | null;
  receiptAttachmentId: string | null;
  receiptAttachment: {
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: string;
    contentSha256: string | null;
  } | null;
  remark: string | null;
  status: V2FinanceJournalStatus;
  createdBy: { id: string; username: string; displayName: string } | null;
  createdAt: IsoDateTimeString;
}

export interface V2FinanceInflowSummary {
  operatingIncomeCny: DecimalString;
  capitalContributionCny: DecimalString;
  borrowedFundsCny: DecimalString;
  totalInflowCny: DecimalString;
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
  manualOperatingIncome: DecimalString;
  capitalContribution: DecimalString;
  borrowedFunds: DecimalString;
  expense: DecimalString;
  netCashFlow: DecimalString;
  exchangeIn?: DecimalString;
  exchangeOut?: DecimalString;
  latestRateToCny: DecimalString | null;
  netCashFlowCny: DecimalString | null;
}

export interface V2FinanceProfitLoss {
  salesRevenueCny: DecimalString;
  otherOperatingRevenueCny: DecimalString;
  bankRechargeRevenueCny?: DecimalString;
  bankRechargeServiceFeeCny?: DecimalString;
  totalOperatingRevenueCny: DecimalString;
  platformFeeCny: DecimalString;
  giftCardCostCny: DecimalString;
  idCostCny: DecimalString;
  customerOwnedBalanceCostCny: DecimalString;
  refundLossCny: DecimalString;
  redemptionLossCny: DecimalString;
  balanceLossCny: DecimalString;
  idPurchaseLossCny: DecimalString;
  operatingExpenseCny: DecimalString;
  bankRechargeCostCny?: DecimalString;
  bankRechargeBankFeeCny?: DecimalString;
  exchangeFeeCny?: DecimalString;
  bankRechargeUsdtFeeCny?: DecimalString;
  bankRechargeShoppingFeeCny?: DecimalString;
  realizedFxGainLossCny: DecimalString;
  netProfitCny: DecimalString;
  estimatedProfitCny: DecimalString;
}

export interface V2FinanceAssetBreakdown {
  cashCny: DecimalString;
  supplierPrepaymentCny: DecimalString;
  giftCardInventoryCny: DecimalString;
  customerOwnedBalanceCostCny: DecimalString;
  unsoldIdInventoryCny: DecimalString;
  supplierRefundReceivableCny: DecimalString;
  totalBookValueCny: DecimalString;
  totalLatestValuationCny: DecimalString | null;
  unrealizedFxChangeCny: DecimalString | null;
}

export interface V2FinanceAfterSales {
  completedOrderCount: number;
  grossRevenueCny: DecimalString;
  refundedRevenueCny: DecimalString;
  platformFeeCny: DecimalString;
  balanceCostCny: DecimalString;
  idCostCny: DecimalString;
  refundLossCny: DecimalString;
  netProfitCny: DecimalString;
  pendingOrderCount: number;
  pendingRevenueCny: DecimalString;
  pendingProfitCny: DecimalString;
}

export interface V2FinanceReconciliationIssue {
  code:
    | 'history_incomplete'
    | 'missing_fx_rate'
    | 'stale_fx_rate'
    | 'order_profit_difference'
    | 'supplier_balance_difference'
    | 'open_supplier_refund'
    | 'missing_finance_journal'
    | 'after_sales_id_cost_nonzero';
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
  afterSales: V2FinanceAfterSales;
  settlementPlatformReport: V2SettlementPlatformReport;
  reconciliation: {
    isComplete: boolean;
    issueCount: number;
    returnedIssueCount: number;
    hasMoreIssues: boolean;
    issues: V2FinanceReconciliationIssue[];
  };
}

export type V2FinanceJournalPage = PaginatedResult<V2FinanceJournal>;
export type V2FinanceExpensePage = PaginatedResult<V2FinanceExpense>;
export type V2FinanceInflowPage = PaginatedResult<V2FinanceInflow> & {
  summary: V2FinanceInflowSummary;
};
export type V2FinanceSupplierLedgerPage = PaginatedResult<V2FinanceSupplierLedgerEntry>;

export function legacyFinanceCurrency(value: string): V2OrderReceiptCurrency {
  if (isV2OrderReceiptCurrency(value)) return value;
  throw new Error('原业务不支持该币种');
}
