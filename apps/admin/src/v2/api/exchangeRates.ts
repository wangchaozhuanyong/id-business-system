import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  CreateV2ExchangeRateEntryInput,
  CreateV2ManualFxRateInput,
  UpdateV2ExchangeRateSettingsInput,
  UpdateV2PurchaseQuoteInput,
  V2ExchangeRateEffective,
  V2ExchangeRateEntry,
  V2ExchangeRateListQuery,
  V2ExchangeRateListResult,
  V2ExchangeRateOverview,
  V2ExchangeRateRecordListQuery,
  V2ExchangeRateRecordListResult,
  V2ExchangeRateRunDetail,
  V2ExchangeRateRunListQuery,
  V2ExchangeRateRunListResult,
  V2ExchangeRateRuntime,
  V2ExchangeRateReceiptFxRate,
  V2ExchangeRateSettings,
  V2ManualFxRate,
  V2ManualFxRateListQuery,
  V2ManualFxRateListResult,
  V2PurchaseQuote,
  V2PurchaseQuoteList,
  V2PurchaseQuoteTextResult,
  V2PurchaseRateHistoryResult,
  V2PurchaseRateRun,
  V2PurchaseRateRunListResult,
  V2PurchaseRateRuntime,
  V2PurchaseRateSettings
} from '@/v2/types/exchangeRates';

export const idBusinessV2ExchangeRatesApi = {
  listRuns(params: V2ExchangeRateRunListQuery, options: ApiRequestOptions = {}) {
    return request<V2ExchangeRateRunListResult>(
      http.get('/id-business-v2/exchange-rates/runs', {
        params,
        signal: options.signal
      })
    );
  },
  getRun(id: string, options: ApiRequestOptions = {}) {
    return request<V2ExchangeRateRunDetail>(
      http.get(`/id-business-v2/exchange-rates/runs/${id}`, { signal: options.signal })
    );
  },
  overview(options: ApiRequestOptions = {}) {
    return request<V2ExchangeRateOverview>(
      http.get('/id-business-v2/exchange-rates/overview', { signal: options.signal })
    );
  },
  runtime(options: ApiRequestOptions = {}) {
    return request<V2ExchangeRateRuntime>(
      http.get('/id-business-v2/exchange-rates/runtime', { signal: options.signal })
    );
  },
  effective(options: ApiRequestOptions = {}) {
    return request<V2ExchangeRateEffective>(
      http.get('/id-business-v2/exchange-rates/effective', { signal: options.signal })
    );
  },
  settings(options: ApiRequestOptions = {}) {
    return request<V2ExchangeRateSettings>(
      http.get('/id-business-v2/exchange-rates/settings', { signal: options.signal })
    );
  },
  listRecords(params: V2ExchangeRateRecordListQuery, options: ApiRequestOptions = {}) {
    return request<V2ExchangeRateRecordListResult>(
      http.get('/id-business-v2/exchange-rates/records', {
        params,
        signal: options.signal
      })
    );
  },
  updateSettings(input: UpdateV2ExchangeRateSettingsInput) {
    return withV2QueryInvalidation(
      request<V2ExchangeRateSettings>(http.patch('/id-business-v2/exchange-rates/settings', input)),
      'exchange-rates'
    );
  },
  collect() {
    return withV2QueryInvalidation(
      request<{
        status: 'success' | 'partial_failed' | 'failed';
        successfulCurrencies: string[];
        failedCurrencies: string[];
        results: Array<{
          currency: string;
          status: 'success' | 'failed';
          rateToCny?: string;
          snapshotId?: string;
          source?: string;
          error?: { code: string; message: string };
        }>;
      }>(http.post('/id-business-v2/exchange-rates/collect')),
      'exchange-rates'
    );
  },
  listManualRates(params: V2ManualFxRateListQuery, options: ApiRequestOptions = {}) {
    return request<V2ManualFxRateListResult>(
      http.get('/id-business-v2/exchange-rates/manual-rates', {
        params,
        signal: options.signal
      })
    );
  },
  getManualRate(id: string) {
    return request<V2ManualFxRate>(http.get(`/id-business-v2/exchange-rates/manual-rates/${id}`));
  },
  createManualRate(input: CreateV2ManualFxRateInput) {
    return withV2QueryInvalidation(
      request<V2ManualFxRate>(http.post('/id-business-v2/exchange-rates/manual-rates', input)),
      'exchange-rates'
    );
  },
  listPurchaseQuotes(options: ApiRequestOptions = {}) {
    return request<V2PurchaseQuoteList>(
      http.get('/id-business-v2/exchange-rates/purchase-quotes', { signal: options.signal })
    );
  },
  getPurchaseQuote(code: string, options: ApiRequestOptions = {}) {
    return request<V2PurchaseQuote>(
      http.get(`/id-business-v2/exchange-rates/purchase-quotes/${code}`, {
        signal: options.signal
      })
    );
  },
  updatePurchaseQuote(code: string, input: UpdateV2PurchaseQuoteInput) {
    return withV2QueryInvalidation(
      request<V2PurchaseQuote>(
        http.patch(`/id-business-v2/exchange-rates/purchase-quotes/${code}`, input)
      ),
      'exchange-rates'
    );
  },
  purchaseRateRuntime(options: ApiRequestOptions = {}) {
    return request<V2PurchaseRateRuntime>(
      http.get('/id-business-v2/exchange-rates/purchase-quotes/runtime', {
        signal: options.signal
      })
    );
  },
  purchaseRateSettings(options: ApiRequestOptions = {}) {
    return request<V2PurchaseRateSettings>(
      http.get('/id-business-v2/exchange-rates/purchase-quotes/settings', {
        signal: options.signal
      })
    );
  },
  updatePurchaseRateSettings(input: {
    autoEnabled: boolean;
    staleMinutes: number;
    abnormalChangePercent: string;
  }) {
    return withV2QueryInvalidation(
      request<V2PurchaseRateSettings>(
        http.patch('/id-business-v2/exchange-rates/purchase-quotes/settings', input)
      ),
      'exchange-rates'
    );
  },
  refreshPurchaseRates() {
    return withV2QueryInvalidation(
      request<{
        status: 'success' | 'failed' | 'pending_review' | 'skipped';
        runId?: string;
        errorMessage?: string;
        abnormalCurrencyCodes?: string[];
      }>(http.post('/id-business-v2/exchange-rates/purchase-quotes/refresh')),
      'exchange-rates'
    );
  },
  listPurchaseRateRuns(
    params: { page?: number; pageSize?: number; status?: string },
    options: ApiRequestOptions = {}
  ) {
    return request<V2PurchaseRateRunListResult>(
      http.get('/id-business-v2/exchange-rates/purchase-quotes/runs', {
        params,
        signal: options.signal
      })
    );
  },
  getPurchaseRateRun(id: string, options: ApiRequestOptions = {}) {
    return request<V2PurchaseRateRun>(
      http.get(`/id-business-v2/exchange-rates/purchase-quotes/runs/${id}`, {
        signal: options.signal
      })
    );
  },
  confirmPurchaseRateRun(id: string, remark?: string) {
    return withV2QueryInvalidation(
      request<{ run: V2PurchaseRateRun }>(
        http.post(`/id-business-v2/exchange-rates/purchase-quotes/runs/${id}/confirm`, {
          remark: remark || null
        })
      ),
      'exchange-rates'
    );
  },
  rejectPurchaseRateRun(id: string, remark?: string) {
    return withV2QueryInvalidation(
      request<{ run: V2PurchaseRateRun }>(
        http.post(`/id-business-v2/exchange-rates/purchase-quotes/runs/${id}/reject`, {
          remark: remark || null
        })
      ),
      'exchange-rates'
    );
  },
  listPurchaseRateHistory(
    params: { page?: number; pageSize?: number; currencyCode?: string },
    options: ApiRequestOptions = {}
  ) {
    return request<V2PurchaseRateHistoryResult>(
      http.get('/id-business-v2/exchange-rates/purchase-quotes/history', {
        params,
        signal: options.signal
      })
    );
  },
  bulkUpdatePurchaseQuotes(input: { currencyCodes: string[]; purchaseRatioPercent: string }) {
    return withV2QueryInvalidation(
      request<V2PurchaseQuoteList>(
        http.patch('/id-business-v2/exchange-rates/purchase-quotes/bulk', input)
      ),
      'exchange-rates'
    );
  },
  generatePurchaseQuoteText(
    format: 'wechat' | 'monospace' | 'plain',
    options: ApiRequestOptions = {}
  ) {
    return request<V2PurchaseQuoteTextResult>(
      http.get('/id-business-v2/exchange-rates/purchase-quotes/text', {
        params: { format },
        signal: options.signal
      })
    );
  },
  listManualEntries(params: V2ExchangeRateListQuery, options: ApiRequestOptions = {}) {
    return request<V2ExchangeRateListResult>(
      http.get('/id-business-v2/exchange-rates/manual-entries', {
        params,
        signal: options.signal
      })
    );
  },
  getManualEntry(id: string) {
    return request<V2ExchangeRateEntry>(
      http.get(`/id-business-v2/exchange-rates/manual-entries/${id}`)
    );
  },
  createManualEntry(input: CreateV2ExchangeRateEntryInput) {
    return withV2QueryInvalidation(
      request<V2ExchangeRateEntry>(
        http.post('/id-business-v2/exchange-rates/manual-entries', input)
      ),
      'exchange-rates'
    );
  },
  bootstrap(
    params: {
      runPage: number;
      runPageSize: number;
      runKeyword?: string;
      runStatus?: string;
      runTriggerType?: string;
      runCollectedFrom?: string;
      runCollectedTo?: string;
      recordPage: number;
      recordPageSize: number;
      recordCurrency?: string;
      recordSource?: string;
      recordStatus?: string;
      recordCapturedFrom?: string;
      recordCapturedTo?: string;
      manualPage: number;
      manualPageSize: number;
      manualKeyword?: string;
      manualCurrency?: string;
      manualRecordedFrom?: string;
      manualRecordedTo?: string;
    },
    options: ApiRequestOptions = {}
  ) {
    return request<{
      overview: V2ExchangeRateOverview;
      runtime: V2ExchangeRateRuntime;
      runs: V2ExchangeRateRunListResult;
      records: V2ExchangeRateRecordListResult;
      manualEntries: V2ManualFxRateListResult;
      purchaseQuotes: V2PurchaseQuoteList;
      latestReceiptFxRates: V2ExchangeRateReceiptFxRate[];
      generatedAt: string;
    }>(
      http.get('/id-business-v2/exchange-rates/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  // Compatibility aliases for the original manual-ledger callers.
  list(params: V2ExchangeRateListQuery, options: ApiRequestOptions = {}) {
    return this.listManualEntries(params, options);
  },
  get(id: string) {
    return this.getManualEntry(id);
  },
  create(input: CreateV2ExchangeRateEntryInput) {
    return this.createManualEntry(input);
  }
};
