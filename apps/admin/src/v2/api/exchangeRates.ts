import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  CreateV2ExchangeRateEntryInput,
  UpdateV2ExchangeRateSettingsInput,
  V2ExchangeRateEffective,
  V2ExchangeRateEntry,
  V2ExchangeRateListQuery,
  V2ExchangeRateListResult,
  V2ExchangeRateOverview,
  V2ExchangeRateRunDetail,
  V2ExchangeRateRunListQuery,
  V2ExchangeRateRunListResult,
  V2ExchangeRateRuntime,
  V2ExchangeRateReceiptFxRate,
  V2ExchangeRateSettings
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
  getRun(id: string) {
    return request<V2ExchangeRateRunDetail>(http.get(`/id-business-v2/exchange-rates/runs/${id}`));
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
  updateSettings(input: UpdateV2ExchangeRateSettingsInput) {
    return withV2QueryInvalidation(
      request<V2ExchangeRateSettings>(http.patch('/id-business-v2/exchange-rates/settings', input)),
      'exchange-rates'
    );
  },
  collect() {
    return withV2QueryInvalidation(
      request<{
        runId: string;
        midRateToRmb: string;
        validSampleCount: number;
      }>(http.post('/id-business-v2/exchange-rates/collect')),
      'exchange-rates'
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
      manualPage: number;
      manualPageSize: number;
      manualKeyword?: string;
      manualRecordedFrom?: string;
      manualRecordedTo?: string;
    },
    options: ApiRequestOptions = {}
  ) {
    return request<{
      overview: V2ExchangeRateOverview;
      runtime: V2ExchangeRateRuntime;
      runs: V2ExchangeRateRunListResult;
      manualEntries: V2ExchangeRateListResult;
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
