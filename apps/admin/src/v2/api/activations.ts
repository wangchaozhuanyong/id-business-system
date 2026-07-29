import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  V2Activation,
  V2ActivationListQuery,
  V2ActivationListResult
} from '@/v2/types/activations';

export const idBusinessV2ActivationsApi = {
  list(params: V2ActivationListQuery, options: ApiRequestOptions = {}) {
    return request<V2ActivationListResult>(
      http.get('/id-business-v2/activations', { params, signal: options.signal })
    );
  },
  get(id: string) {
    return request<V2Activation>(http.get(`/id-business-v2/activations/${id}`));
  }
};
