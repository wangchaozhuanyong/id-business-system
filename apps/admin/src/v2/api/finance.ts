import type {
  V2FinanceAccount,
  V2FinanceAccountStatus,
  V2FinanceAccountType,
  V2FinanceCurrency,
  V2FinanceExpense,
  V2FinanceExpensePage,
  V2FinanceLatestRate,
  V2FinanceHistoryBackfillPreview,
  V2FinanceHistoryBackfillResult,
  V2FinanceHistoryConfirmationPreview,
  V2FinanceInflow,
  V2FinanceInflowNature,
  V2FinanceInflowPage,
  V2FinanceInflowSummary,
  V2FinanceJournal,
  V2FinanceJournalPage,
  V2FinanceJournalType,
  V2FinanceOverview,
  V2FinancePeriod,
  V2FinanceSettings,
  V2FinanceSupplierLedgerPage,
  V2FinanceSupplierWallet
} from '@apple-business/shared';
import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type { V2OptionSelector } from '@/v2/types/options';

export interface V2FinanceReportQuery {
  dateFrom?: string;
  dateTo?: string;
  currency?: V2FinanceCurrency | '';
  supplierOptionId?: string;
  journalType?: V2FinanceJournalType | '';
  financeAccountId?: string;
  settlementPlatformOptionId?: string;
}

export interface V2FinanceJournalQuery extends V2FinanceReportQuery {
  page?: number;
  pageSize?: number;
  sourceType?: string;
  sourceId?: string;
  periodMonth?: string;
}

export interface V2DataAnalyticsBootstrap {
  overview: V2FinanceOverview;
  accounts: V2FinanceAccount[];
  wallets: V2FinanceSupplierWallet[];
  journals: V2FinanceJournal[];
  generatedAt: string;
}

export interface V2FinanceHistoryConfirmationInput {
  financeAccountsConfirmed: boolean;
  supplierBalancesConfirmed: boolean;
  historicalExpensesConfirmed: boolean;
  previewFingerprint: string;
  note: string;
}

export interface V2FinanceExpenseQuery {
  page?: number;
  pageSize?: number;
  categoryOptionId?: string;
  financeAccountId?: string;
  currency?: V2FinanceCurrency | '';
  dateFrom?: string;
  dateTo?: string;
}

export interface V2FinanceInflowQuery {
  page?: number;
  pageSize?: number;
  nature?: V2FinanceInflowNature | '';
  categoryOptionId?: string;
  financeAccountId?: string;
  currency?: V2FinanceCurrency | '';
  dateFrom?: string;
  dateTo?: string;
}

interface V2FinanceInflowWritePayload {
  nature: V2FinanceInflowNature;
  categoryOptionId?: string;
  financeAccountId: string;
  amount: string;
  currency: V2FinanceCurrency;
  occurredAt: string;
  fxRateToCny?: string;
  manualRateReason?: string;
  payer?: string;
  externalReference?: string;
  receiptAttachmentId?: string;
  remark?: string;
  idempotencyKey: string;
}

function buildInflowFormData(
  payload: V2FinanceInflowWritePayload & { reason?: string },
  receipt?: File | null
) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== '') formData.append(key, value);
  }
  if (receipt) formData.append('receipt', receipt, receipt.name);
  return formData;
}

export interface V2FinanceLedgerBootstrap {
  accounts: V2FinanceAccount[];
  wallets: V2FinanceSupplierWallet[];
  inflows: {
    items: V2FinanceInflow[];
    total: number;
    summary: V2FinanceInflowSummary;
  };
  expenses: { items: V2FinanceExpense[]; total: number };
  journals: { items: V2FinanceJournal[]; total: number };
  periods: V2FinancePeriod[];
  settings: V2FinanceSettings;
  supplierOptions: V2OptionSelector[];
  expenseCategories: V2OptionSelector[];
  incomeCategories: V2OptionSelector[];
  generatedAt: string;
}

const FINANCE_SCOPES = [
  'finance-accounts',
  'finance-ledger',
  'finance-reports',
  'balances-options'
] as const;

export const idBusinessV2FinanceApi = {
  analyticsBootstrap(params: V2FinanceReportQuery, options: ApiRequestOptions = {}) {
    return request<V2DataAnalyticsBootstrap>(
      http.get('/id-business-v2/finance/analytics/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  bootstrapLedger(
    params: {
      currency?: V2FinanceCurrency | '';
      inflowNature?: V2FinanceInflowNature | '';
      inflowPage: number;
      expensePage: number;
      journalPage: number;
      pageSize: number;
      periodMonth?: string;
      journalType?: V2FinanceJournalType | '';
    },
    options: ApiRequestOptions = {}
  ) {
    return request<V2FinanceLedgerBootstrap>(
      http.get('/id-business-v2/finance/ledger/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  overview(params: V2FinanceReportQuery, options: ApiRequestOptions = {}) {
    return request<V2FinanceOverview>(
      http.get('/id-business-v2/finance/reports/overview', {
        params,
        signal: options.signal
      })
    );
  },
  listAccounts(
    params: { currency?: V2FinanceCurrency | ''; status?: V2FinanceAccountStatus | '' } = {},
    options: ApiRequestOptions = {}
  ) {
    return request<{ items: V2FinanceAccount[] }>(
      http.get('/id-business-v2/finance/accounts', { params, signal: options.signal })
    );
  },
  createAccount(payload: {
    name: string;
    accountType: V2FinanceAccountType;
    currency: V2FinanceCurrency;
    openingBalance: string;
    fxRateToCny?: string;
    manualRateReason?: string;
    remark?: string;
    idempotencyKey: string;
  }) {
    return withV2QueryInvalidation(
      request<V2FinanceAccount>(http.post('/id-business-v2/finance/accounts', payload)),
      FINANCE_SCOPES
    );
  },
  updateAccount(
    id: string,
    payload: {
      expectedUpdatedAt: string;
      name?: string;
      status?: V2FinanceAccountStatus;
      remark?: string;
    }
  ) {
    return withV2QueryInvalidation(
      request<V2FinanceAccount>(http.patch(`/id-business-v2/finance/accounts/${id}`, payload)),
      FINANCE_SCOPES
    );
  },
  listSupplierWallets(
    params: { currency?: V2FinanceCurrency | ''; supplierOptionId?: string } = {},
    options: ApiRequestOptions = {}
  ) {
    return request<{ items: V2FinanceSupplierWallet[] }>(
      http.get('/id-business-v2/finance/supplier-wallets', {
        params,
        signal: options.signal
      })
    );
  },
  createSupplierWallet(payload: {
    supplierOptionId: string;
    currency: V2FinanceCurrency;
    openingBalance: string;
    fxRateToCny?: string;
    manualRateReason?: string;
    reason: string;
    idempotencyKey: string;
  }) {
    return withV2QueryInvalidation(
      request<V2FinanceSupplierWallet>(
        http.post('/id-business-v2/finance/supplier-wallets', payload)
      ),
      FINANCE_SCOPES
    );
  },
  listSupplierLedger(
    id: string,
    params: { page?: number; pageSize?: number },
    options: ApiRequestOptions = {}
  ) {
    return request<V2FinanceSupplierLedgerPage>(
      http.get(`/id-business-v2/finance/supplier-wallets/${id}/ledger`, {
        params,
        signal: options.signal
      })
    );
  },
  depositSupplierWallet(
    id: string,
    payload: {
      financeAccountId: string;
      paidAmount: string;
      creditedAmount?: string;
      networkFeeAmount?: string;
      paidAt: string;
      fxRateToCny?: string;
      manualRateReason?: string;
      network?: string;
      transactionHash?: string;
      remark?: string;
      idempotencyKey: string;
    }
  ) {
    return withV2QueryInvalidation(
      request(http.post(`/id-business-v2/finance/supplier-wallets/${id}/deposits`, payload)),
      FINANCE_SCOPES
    );
  },
  refundSupplierWallet(
    id: string,
    payload: {
      financeAccountId: string;
      amount: string;
      receivedAt: string;
      fxRateToCny?: string;
      manualRateReason?: string;
      reason: string;
      idempotencyKey: string;
    }
  ) {
    return withV2QueryInvalidation(
      request(http.post(`/id-business-v2/finance/supplier-wallets/${id}/refunds`, payload)),
      FINANCE_SCOPES
    );
  },
  adjustSupplierWallet(
    id: string,
    payload: {
      targetBalance: string;
      fxRateToCny?: string;
      manualRateReason?: string;
      reason: string;
      idempotencyKey: string;
    }
  ) {
    return withV2QueryInvalidation(
      request(http.post(`/id-business-v2/finance/supplier-wallets/${id}/adjustments`, payload)),
      FINANCE_SCOPES
    );
  },
  listExpenses(params: V2FinanceExpenseQuery, options: ApiRequestOptions = {}) {
    return request<V2FinanceExpensePage>(
      http.get('/id-business-v2/finance/expenses', { params, signal: options.signal })
    );
  },
  listInflows(params: V2FinanceInflowQuery, options: ApiRequestOptions = {}) {
    return request<V2FinanceInflowPage>(
      http.get('/id-business-v2/finance/inflows', { params, signal: options.signal })
    );
  },
  createInflow(payload: V2FinanceInflowWritePayload, receipt?: File | null) {
    return withV2QueryInvalidation(
      request<V2FinanceInflow>(
        http.post('/id-business-v2/finance/inflows', buildInflowFormData(payload, receipt))
      ),
      FINANCE_SCOPES
    );
  },
  correctInflow(
    id: string,
    payload: V2FinanceInflowWritePayload & { reason: string },
    receipt?: File | null
  ) {
    return withV2QueryInvalidation(
      request<V2FinanceInflow>(
        http.post(
          `/id-business-v2/finance/inflows/${id}/corrections`,
          buildInflowFormData(payload, receipt)
        )
      ),
      FINANCE_SCOPES
    );
  },
  async downloadInflowReceipt(id: string) {
    const response = await http.get<Blob>(`/id-business-v2/finance/inflows/${id}/receipt`, {
      responseType: 'blob'
    });
    return response.data;
  },
  createExpense(payload: {
    categoryOptionId: string;
    financeAccountId: string;
    amount: string;
    currency: V2FinanceCurrency;
    occurredAt: string;
    fxRateToCny?: string;
    manualRateReason?: string;
    payee?: string;
    remark?: string;
    idempotencyKey: string;
  }) {
    return withV2QueryInvalidation(
      request<V2FinanceExpense>(http.post('/id-business-v2/finance/expenses', payload)),
      FINANCE_SCOPES
    );
  },
  correctExpense(
    id: string,
    payload: {
      categoryOptionId: string;
      financeAccountId: string;
      amount: string;
      currency: V2FinanceCurrency;
      occurredAt: string;
      fxRateToCny?: string;
      manualRateReason?: string;
      payee?: string;
      remark?: string;
      reason: string;
      idempotencyKey: string;
    }
  ) {
    return withV2QueryInvalidation(
      request<V2FinanceExpense>(
        http.post(`/id-business-v2/finance/expenses/${id}/corrections`, payload)
      ),
      FINANCE_SCOPES
    );
  },
  listJournals(params: V2FinanceJournalQuery, options: ApiRequestOptions = {}) {
    return request<V2FinanceJournalPage>(
      http.get('/id-business-v2/finance/journals', { params, signal: options.signal })
    );
  },
  reverseJournal(id: string, payload: { reason: string; idempotencyKey: string }) {
    return withV2QueryInvalidation(
      request<V2FinanceJournal>(
        http.post(`/id-business-v2/finance/journals/${id}/reverse`, payload)
      ),
      FINANCE_SCOPES
    );
  },
  listPeriods(options: ApiRequestOptions = {}) {
    return request<V2FinancePeriod[]>(
      http.get('/id-business-v2/finance/periods', { signal: options.signal })
    );
  },
  closePeriod(month: string) {
    return withV2QueryInvalidation(
      request<V2FinancePeriod>(
        http.post(`/id-business-v2/finance/periods/${encodeURIComponent(month)}/close`)
      ),
      FINANCE_SCOPES
    );
  },
  reopenPeriod(month: string, reason: string) {
    return withV2QueryInvalidation(
      request<V2FinancePeriod>(
        http.post(`/id-business-v2/finance/periods/${encodeURIComponent(month)}/reopen`, {
          reason
        })
      ),
      FINANCE_SCOPES
    );
  },
  listLatestFxRates(options: ApiRequestOptions = {}) {
    return request<{ items: V2FinanceLatestRate[]; generatedAt: string }>(
      http.get('/id-business-v2/finance/fx-rates/latest', { signal: options.signal })
    );
  },
  getSettings(options: ApiRequestOptions = {}) {
    return request<V2FinanceSettings>(
      http.get('/id-business-v2/finance/settings', { signal: options.signal })
    );
  },
  previewHistoryBackfill() {
    return request<V2FinanceHistoryBackfillPreview>(
      http.get('/id-business-v2/finance/history/backfill-preview')
    );
  },
  backfillHistory(previewFingerprint: string, previewAsOf: string) {
    return withV2QueryInvalidation(
      request<V2FinanceHistoryBackfillResult>(
        http.post('/id-business-v2/finance/history/backfill', {
          previewFingerprint,
          previewAsOf
        })
      ),
      FINANCE_SCOPES
    );
  },
  previewHistoryConfirmation() {
    return request<V2FinanceHistoryConfirmationPreview>(
      http.get('/id-business-v2/finance/history/confirmation-preview')
    );
  },
  confirmHistory(input: V2FinanceHistoryConfirmationInput) {
    return withV2QueryInvalidation(
      request<V2FinanceSettings>(
        http.post('/id-business-v2/finance/history/confirm', {
          confirmed: true,
          ...input
        })
      ),
      FINANCE_SCOPES
    );
  },
  reopenHistoryConfirmation(reason: string) {
    return withV2QueryInvalidation(
      request<V2FinanceSettings>(
        http.post('/id-business-v2/finance/history/reopen-confirmation', { reason })
      ),
      FINANCE_SCOPES
    );
  }
};
