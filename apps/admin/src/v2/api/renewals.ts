import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  V2ManualRenewalOptions,
  V2ManualRenewalPayload,
  V2ManualRenewalResult,
  V2RenewalFilterOptions,
  V2RenewalWarningSettings,
  V2RenewalWarningSummary,
  V2RenewalWorkbenchQuery,
  V2RenewalWorkbenchResult
} from '@/v2/types/renewals';

export const idBusinessV2RenewalsApi = {
  listWorkbench(params: V2RenewalWorkbenchQuery, options: ApiRequestOptions = {}) {
    return request<V2RenewalWorkbenchResult>(
      http.get('/id-business-v2/renewals/workbench', {
        params,
        signal: options.signal
      })
    );
  },
  bootstrapWorkbench(params: V2RenewalWorkbenchQuery, options: ApiRequestOptions = {}) {
    return request<{
      list: V2RenewalWorkbenchResult;
      options: {
        filters: V2RenewalFilterOptions;
        manualRenewal: V2ManualRenewalOptions | null;
      };
      generatedAt: string;
    }>(
      http.get('/id-business-v2/renewals/workbench/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  listFilterOptions() {
    return request<V2RenewalFilterOptions>(
      http.get('/id-business-v2/renewals/workbench/filter-options')
    );
  },
  listManualRenewalOptions() {
    return request<V2ManualRenewalOptions>(
      http.get('/id-business-v2/renewals/workbench/manual-renewal-options')
    );
  },
  getWarningSettings(options: ApiRequestOptions = {}) {
    return request<V2RenewalWarningSettings>(
      http.get('/id-business-v2/renewals/warning-settings', {
        signal: options.signal
      })
    );
  },
  updateWarningSettings(warningDays: number, expectedUpdatedAt: string | null) {
    return withV2QueryInvalidation(
      request<V2RenewalWarningSettings>(
        http.patch('/id-business-v2/renewals/warning-settings', {
          warningDays,
          expectedUpdatedAt
        })
      ),
      ['renewals', 'renewal-warning-settings', 'renewal-warning-summary']
    );
  },
  getWarningSummary(options: ApiRequestOptions = {}) {
    return request<V2RenewalWarningSummary>(
      http.get('/id-business-v2/renewals/warning-summary', {
        signal: options.signal
      })
    );
  },
  createManualRenewal(activationId: string, payload: V2ManualRenewalPayload) {
    return withV2QueryInvalidation(
      request<V2ManualRenewalResult>(
        http.post(`/id-business-v2/renewals/${activationId}/manual-renewals`, payload)
      ),
      [
        'renewals',
        'orders',
        'accounts',
        'balances',
        'balance-records',
        'activations',
        'order-entry-options',
        'renewal-warning-summary'
      ]
    );
  }
};
