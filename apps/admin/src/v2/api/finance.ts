import type {
  V2FinanceAccount,
  V2FinanceAccountStatus,
  V2FinanceAccountType,
  V2FinanceCurrency,
  V2FinanceExpense,
  V2FinanceExpensePage,
  V2FinanceLatestRate,
  V2FinanceHistoryBackfillResult,
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

export interface V2FinanceReportQuery {
  dateFrom?: string;
  dateTo?: string;
  currency?: V2FinanceCurrency | '';
  supplierOptionId?: string;
  journalType?: V2FinanceJournalType | '';
  financeAccountId?: string;
}

export interface V2FinanceJournalQuery extends V2FinanceReportQuery {
  page?: number;
  pageSize?: number;
  sourceType?: string;
  sourceId?: string;
  periodMonth?: string;
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

const FINANCE_SCOPES = [
  'finance-accounts',
  'finance-ledger',
  'finance-reports',
  'balances-options'
] as const;

export const idBusinessV2FinanceApi = {
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
    payload: { name?: string; status?: V2FinanceAccountStatus; remark?: string }
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
  backfillHistory() {
    return withV2QueryInvalidation(
      request<V2FinanceHistoryBackfillResult>(
        http.post('/id-business-v2/finance/history/backfill')
      ),
      FINANCE_SCOPES
    );
  },
  confirmHistory(note: string) {
    return withV2QueryInvalidation(
      request<V2FinanceSettings>(
        http.post('/id-business-v2/finance/history/confirm', {
          confirmed: true,
          note
        })
      ),
      FINANCE_SCOPES
    );
  }
};
