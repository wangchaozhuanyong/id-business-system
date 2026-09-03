export interface ApiSuccessResponse<TData> {
  success: true;
  data: TData;
  message: string;
  requestId: string;
  timestamp: string;
}

export interface ApiErrorResponse {
  success: false;
  errorCode: string;
  message: string;
  retryable: boolean;
  /** Legacy response compatibility only. Clients must not display or log this payload. */
  details?: Record<string, unknown>;
  requestId: string;
  retryAfterMs?: number;
  fieldErrors?: Record<string, string[]>;
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
} from './v2/common.js';
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
} from './v2/decimal.js';
export {
  V2_PURCHASE_RATE_ROUNDING_MODES,
  calculateV2PurchaseRate,
  formatV2PurchaseRate,
  type CalculateV2PurchaseRateInput,
  type V2PurchaseRateCalculation,
  type V2PurchaseRateRoundingMode
} from './v2/purchase-rate.js';
export {
  V2_BRANDING_DEFAULTS,
  V2_BRANDING_LIMITS,
  splitV2BrandingHeroTitle,
  type UpdateV2BrandingSettingsInput,
  type V2BrandingSettings
} from './v2/branding.js';
export {
  V2_DATA_SCOPES,
  V2_SCOPE_DEPENDENCIES,
  expandV2DataScopes,
  isV2DataScope,
  type V2ChangeEvent,
  type V2ChangeVersionsResult,
  type V2DataScope,
  type V2ScopeVersion
} from './v2/data-scopes.js';
export {
  V2_TABLE_PREFERENCE_LIMITS,
  type ResetV2TablePreferenceResult,
  type UpdateV2TablePreferenceInput,
  type V2TablePreference,
  type V2TablePreferenceList
} from './v2/table-preferences.js';
export {
  V2_MAIL_VIEWER_LIMITS,
  V2_MAILBOX_OAUTH_STATUSES,
  V2_MAIL_PROVIDERS,
  V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY,
  V2_MANAGED_MAILBOX_STATUSES,
  V2_PASSWORD_MAIL_PROVIDERS,
  V2_SAVED_TOTP_ACCOUNT_LIMITS,
  V2_RELAY_JOB_STATUSES,
  V2_RELAY_JOB_STEPS,
  V2_TOTP_ALGORITHMS,
  V2_WORKSPACE_SHORTCUT_LIMITS,
  type CreateV2ManagedMailboxBatchInput,
  type CreateV2ManagedMailboxBatchResult,
  type CreateV2ManagedMailboxInput,
  type CreateV2ManagedMailboxResult,
  type CreateV2SavedTotpAccountInput,
  type CreateV2WorkspaceShortcutInput,
  type RotateV2ManagedMailboxQueryCodeResult,
  type CreateV2RelayJobInput,
  type LoginV2RelayCloudBridgeInput,
  type LoginV2RelayCloudBridgeResult,
  type ReorderV2WorkspaceShortcutsInput,
  type StartV2MicrosoftMailboxAuthorizationInput,
  type StartV2MicrosoftMailboxAuthorizationResult,
  type StartV2RelayGoogleAuthorizationResult,
  type SaveV2RelayGoogleOAuthInput,
  type UpdateV2ManagedMailboxCredentialInput,
  type UpdateV2ManagedMailboxQueryCodeSettingsInput,
  type UpdateV2ManagedMailboxQueryCodeSettingsResult,
  type UpdateV2ManagedMailboxStatusInput,
  type UpdateV2SavedTotpAccountInput,
  type UpdateV2WorkspaceShortcutInput,
  type V2MailProvider,
  type V2MailboxOAuthStatus,
  type V2MailViewerMessage,
  type V2MailViewerQueryInput,
  type V2MailViewerQueryResult,
  type V2ManagedMailbox,
  type V2ManagedMailboxBatchResultItem,
  type V2ManagedMailboxList,
  type V2ManagedMailboxListQuery,
  type V2ManagedMailboxQueryCodeSettings,
  type V2ManagedMailboxStatus,
  type V2MicrosoftMailboxAuthorizationStatus,
  type V2RelayConnectionStatus,
  type V2RelayDeploymentOptions,
  type V2RelayJob,
  type V2RelayJobList,
  type V2RelayJobStatus,
  type V2RelayJobStep,
  type V2RelayReferenceAccount,
  type V2RelaySelectOption,
  type V2PasswordMailProvider,
  type V2SavedTotpAccount,
  type V2SavedTotpAccountList,
  type V2TotpAlgorithm,
  type V2WorkspaceShortcut,
  type V2WorkspaceShortcutList
} from './v2/workspace.js';
export {
  V2_FINANCE_ACCOUNT_TYPES,
  V2_FINANCE_CURRENCIES,
  type V2FinanceAccount,
  type V2FinanceAccountCode,
  type V2FinanceAccountStatus,
  type V2FinanceAccountType,
  type V2FinanceAfterSales,
  type V2FinanceAssetBreakdown,
  type V2FinanceCurrency,
  type V2FinanceCurrencyBreakdown,
  type V2FinanceExpense,
  type V2FinanceExpensePage,
  type V2FinanceFxRateSnapshot,
  type V2FinanceHistoryBackfillPreview,
  type V2FinanceHistoryBackfillPreviewCategory,
  type V2FinanceHistoryBackfillResult,
  type V2FinanceHistoryConfirmationPreview,
  type V2FinanceHistoryStatus,
  type V2FinanceInflow,
  type V2FinanceInflowNature,
  type V2FinanceInflowPage,
  type V2FinanceInflowSummary,
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
  type V2FinanceSupplierWallet,
  type V2OrderReceiptFxQuote,
  type V2SettlementPlatformOriginalAmount,
  type V2SettlementPlatformReport,
  type V2SettlementPlatformReportRow
} from './v2/finance.js';
