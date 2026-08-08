import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  UnfreezeV2AccountLossInput,
  UnfreezeV2AccountLossResult,
  V2AccountLossListQuery,
  V2AccountLossListResult
} from '@/v2/types/records';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';

export const idBusinessV2AccountLossesApi = {
  list(params: V2AccountLossListQuery, options: ApiRequestOptions = {}) {
    return request<V2AccountLossListResult>(
      http.get('/id-business-v2/account-losses', {
        params,
        signal: options.signal
      })
    );
  },
  recover(accountId: string, payload: UnfreezeV2AccountLossInput) {
    return withV2QueryInvalidation(
      request<UnfreezeV2AccountLossResult>(
        http.post(`/id-business-v2/accounts/${accountId}/unfreeze-loss`, payload)
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
        'renewal-warning-summary',
        'finance-ledger',
        'finance-reports'
      ]
    );
  }
};
