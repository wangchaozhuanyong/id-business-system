import { http, request, type ApiRequestOptions } from '@/api/client';
import type { V2AccountLossListQuery, V2AccountLossListResult } from '@/v2/types/records';

export const idBusinessV2AccountLossesApi = {
  list(params: V2AccountLossListQuery, options: ApiRequestOptions = {}) {
    return request<V2AccountLossListResult>(
      http.get('/id-business-v2/account-losses', {
        params,
        signal: options.signal
      })
    );
  }
};
