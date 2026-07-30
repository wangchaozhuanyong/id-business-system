export interface ApiSuccessResponse<TData> {
  success: true;
  data: TData;
  message: string;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  errorCode: string;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;

export type {
  DecimalString,
  IsoDateTimeString,
  PaginatedResult,
  PaginationQueryContract,
  V2PageQuery,
  V2SortOrder
} from './v2/common';
export {
  V2_DECIMAL_PLACES,
  V2_DECIMAL_STEP,
  V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
  addDecimalStrings,
  divideDecimalStrings,
  isV2UnsignedDecimal,
  multiplyDecimalStrings,
  roundDecimalString,
  v2UnsignedDecimalPattern
} from './v2/decimal';
export {
  V2_DATA_SCOPES,
  V2_SCOPE_DEPENDENCIES,
  expandV2DataScopes,
  isV2DataScope,
  type V2ChangeEvent,
  type V2ChangeVersionsResult,
  type V2DataScope,
  type V2ScopeVersion
} from './v2/data-scopes';
export {
  V2_FINANCE_ACCOUNT_TYPES,
  V2_FINANCE_CURRENCIES,
  type V2FinanceAccount,
  type V2FinanceAccountCode,
  type V2FinanceAccountStatus,
  type V2FinanceAccountType,
  type V2FinanceAssetBreakdown,
  type V2FinanceCurrency,
  type V2FinanceCurrencyBreakdown,
  type V2FinanceExpense,
  type V2FinanceExpensePage,
  type V2FinanceFxRateSnapshot,
  type V2FinanceHistoryBackfillResult,
  type V2FinanceHistoryStatus,
  type V2FinanceLatestRate,
  type V2FinanceJournal,
  type V2FinanceJournalLine,
  type V2FinanceJournalPage,
  type V2FinanceJournalStatus,
  type V2FinanceJournalType,
  type V2FinanceLineDirection,
  type V2FinanceOverview,
  type V2FinancePeriod,
  type V2FinancePeriodStatus,
  type V2FinanceProfitLoss,
  type V2FinanceReconciliationIssue,
  type V2FinanceSettings,
  type V2FinanceSupplierLedgerEntry,
  type V2FinanceSupplierLedgerPage,
  type V2FinanceSupplierWallet
} from './v2/finance';
