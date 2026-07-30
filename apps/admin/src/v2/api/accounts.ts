import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  CreateV2AccountInput,
  ImportV2AccountRowInput,
  ReportV2AccountLossInput,
  ReportV2AccountLossResult,
  UpdateV2AccountInput,
  V2Account,
  V2AccountExportResult,
  V2AccountImportResult,
  V2AccountListQuery,
  V2AccountListResult,
  V2AccountPurchaseSources,
  V2AccountSecretField,
  V2RevealInput
} from '@/v2/types/records';
import type { V2OptionSelector } from '@/v2/types/options';

export const idBusinessV2AccountsApi = {
  list(params: V2AccountListQuery, options: ApiRequestOptions = {}) {
    return request<V2AccountListResult>(
      http.get('/id-business-v2/accounts', { params, signal: options.signal })
    );
  },
  bootstrap(params: V2AccountListQuery, options: ApiRequestOptions = {}) {
    return request<{
      list: V2AccountListResult;
      options: {
        countries: V2OptionSelector[];
        statuses: V2OptionSelector[];
        suppliers: V2OptionSelector[];
      };
      generatedAt: string;
    }>(
      http.get('/id-business-v2/accounts/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  exportRows(params: Omit<V2AccountListQuery, 'page' | 'pageSize'>) {
    return request<V2AccountExportResult>(http.get('/id-business-v2/accounts/export', { params }));
  },
  purchaseSources(options: ApiRequestOptions = {}) {
    return request<V2AccountPurchaseSources>(
      http.get('/id-business-v2/accounts/purchase-sources', {
        signal: options.signal
      })
    );
  },
  importRows(rows: ImportV2AccountRowInput[]) {
    return withV2QueryInvalidation(
      request<V2AccountImportResult>(http.post('/id-business-v2/accounts/import', { rows })),
      [
        'accounts',
        'balances',
        'order-entry-options',
        'order-entry-matching',
        'renewals',
        'renewals-options',
        'finance-ledger',
        'finance-reports'
      ]
    );
  },
  get(id: string) {
    return request<V2Account>(http.get(`/id-business-v2/accounts/${id}`));
  },
  create(payload: CreateV2AccountInput) {
    return withV2QueryInvalidation(
      request<V2Account>(http.post('/id-business-v2/accounts', payload)),
      [
        'accounts',
        'balances',
        'order-entry-options',
        'order-entry-matching',
        'renewals',
        'renewals-options',
        'finance-ledger',
        'finance-reports'
      ]
    );
  },
  update(id: string, payload: UpdateV2AccountInput) {
    return withV2QueryInvalidation(
      request<V2Account>(http.patch(`/id-business-v2/accounts/${id}`, payload)),
      [
        'accounts',
        'balances',
        'balance-records',
        'order-entry-options',
        'order-entry-matching',
        'renewals',
        'renewals-options'
      ]
    );
  },
  reportLoss(id: string, payload: ReportV2AccountLossInput) {
    return withV2QueryInvalidation(
      request<ReportV2AccountLossResult>(
        http.post(`/id-business-v2/accounts/${id}/report-loss`, payload)
      ),
      [
        'account-losses',
        'accounts',
        'balances',
        'balance-records',
        'orders',
        'activations',
        'order-entry-options',
        'order-entry-matching',
        'renewals',
        'renewals-options',
        'renewal-warning-summary'
      ]
    );
  },
  revealSecret(id: string, field: V2AccountSecretField, payload: V2RevealInput) {
    return request<{
      accountId: string;
      field: V2AccountSecretField;
      value: string;
      revealedAt: string;
    }>(http.post(`/id-business-v2/accounts/${id}/reveal-secret`, { ...payload, field }));
  },
  remove(id: string) {
    return withV2QueryInvalidation(
      request<{ deleted: true }>(http.delete(`/id-business-v2/accounts/${id}`)),
      [
        'accounts',
        'balances',
        'order-entry-options',
        'order-entry-matching',
        'renewals',
        'renewals-options'
      ]
    );
  }
};
