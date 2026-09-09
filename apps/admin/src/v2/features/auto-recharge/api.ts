import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  ImportV2RechargeAddressesResult,
  V2RechargeAddress,
  V2RechargeAddressList,
  V2RechargeAddressListQuery,
  V2RechargeAddressStatus,
  V2RechargeStart,
  V2RechargeJob
} from './contracts';
const base = '/id-business-v2/auto-recharge/jobs';
export const rechargeApi = {
  list(options: ApiRequestOptions = {}) {
    return request<{ items: V2RechargeJob[]; configured: boolean }>(
      http.get(base, { signal: options.signal })
    );
  },
  start(input: V2RechargeStart) {
    return request<{ id: string }>(http.post(base, input));
  },
  confirm(id: string, nonce: string) {
    return request(http.post(`${base}/${id}/confirm`, { nonce }));
  },
  cancel(id: string) {
    return request(http.post(`${base}/${id}/cancel`, {}));
  },
  listAddresses(query: V2RechargeAddressListQuery, options: ApiRequestOptions = {}) {
    return request<V2RechargeAddressList>(
      http.get('/id-business-v2/auto-recharge/addresses', {
        params: query,
        signal: options.signal
      })
    );
  },
  importAddresses(streets: string[]) {
    return request<ImportV2RechargeAddressesResult>(
      http.post('/id-business-v2/auto-recharge/addresses/import', { streets })
    );
  },
  updateAddressStatus(id: string, status: V2RechargeAddressStatus) {
    return request<V2RechargeAddress>(
      http.patch(`/id-business-v2/auto-recharge/addresses/${id}/status`, { status })
    );
  }
};
