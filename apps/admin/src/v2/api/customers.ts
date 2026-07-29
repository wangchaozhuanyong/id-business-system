import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  CreateV2CustomerInput,
  UpdateV2CustomerInput,
  V2Customer,
  V2CustomerListQuery,
  V2CustomerListResult,
  V2RevealInput
} from '@/v2/types/records';
import type { V2OptionSelector } from '@/v2/types/options';

export const idBusinessV2CustomersApi = {
  list(params: V2CustomerListQuery, options: ApiRequestOptions = {}) {
    return request<V2CustomerListResult>(
      http.get('/id-business-v2/customers', { params, signal: options.signal })
    );
  },
  bootstrap(params: V2CustomerListQuery, options: ApiRequestOptions = {}) {
    return request<{
      list: V2CustomerListResult;
      options: {
        sources: V2OptionSelector[];
        tags: V2OptionSelector[];
        services: V2OptionSelector[];
      };
      generatedAt: string;
    }>(
      http.get('/id-business-v2/customers/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  get(id: string) {
    return request<V2Customer>(http.get(`/id-business-v2/customers/${id}`));
  },
  create(payload: CreateV2CustomerInput) {
    return withV2QueryInvalidation(
      request<V2Customer>(http.post('/id-business-v2/customers', payload)),
      ['customers', 'order-entry-options', 'orders', 'renewals', 'renewals-options']
    );
  },
  update(id: string, payload: UpdateV2CustomerInput) {
    return withV2QueryInvalidation(
      request<V2Customer>(http.patch(`/id-business-v2/customers/${id}`, payload)),
      ['customers', 'order-entry-options', 'orders', 'renewals', 'renewals-options']
    );
  },
  revealPhone(id: string, payload: V2RevealInput) {
    return request<{ customerId: string; phone: string; revealedAt: string }>(
      http.post(`/id-business-v2/customers/${id}/reveal-phone`, payload)
    );
  },
  remove(id: string) {
    return withV2QueryInvalidation(
      request<{ deleted: true }>(http.delete(`/id-business-v2/customers/${id}`)),
      ['customers', 'order-entry-options', 'orders', 'renewals', 'renewals-options']
    );
  }
};
