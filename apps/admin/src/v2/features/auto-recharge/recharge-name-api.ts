import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
export interface RechargeNameItem {
  id: string;
  sequence: number;
  name: string;
  active: boolean;
  matchCount: number;
  lastMatchedAt: string | null;
  updatedAt: string;
}
const base = '/id-business-v2/auto-recharge/names';
export const rechargeNameApi = {
  list(
    params: { page: number; pageSize: number; keyword: string; status: string },
    options: ApiRequestOptions = {}
  ) {
    return request<{ items: RechargeNameItem[]; total: number; page: number; pageSize: number }>(
      http.get(base, { params, signal: options.signal })
    );
  },
  import(names: string[]) {
    return withV2QueryInvalidation(
      request<{ imported: number; skipped: number }>(http.post(`${base}/import`, { names })),
      'auto-recharge'
    );
  },
  update(id: string, input: { name?: string; active?: boolean; expectedUpdatedAt: string }) {
    return withV2QueryInvalidation(
      request<{ id: string }>(http.patch(`${base}/${id}`, input)),
      'auto-recharge'
    );
  }
};
