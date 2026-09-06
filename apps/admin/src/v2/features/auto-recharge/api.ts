import { http, request, type ApiRequestOptions } from '@/api/client';
import type { V2RechargeStart, V2RechargeJob } from './contracts';
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
  }
};
