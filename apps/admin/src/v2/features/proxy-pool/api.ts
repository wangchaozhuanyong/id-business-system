import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';

const base = '/id-business-v2/proxy-pool';

import type {
  ProxyPoolItem,
  RechargeProxyItem,
  RechargeProxyDetail,
  RechargeProxyWrite
} from './contracts';
export type {
  ProxyPoolItem,
  RechargeProxyItem,
  RechargeProxyDetail,
  RechargeProxyWrite
} from './contracts';

export const proxyPoolApi = {
  list(
    query: {
      page: number;
      pageSize: number;
      keyword?: string;
      countryCode?: string;
      kind?: string;
      status?: string;
      completeOnly?: string;
      sortOrder?: string;
    },
    options: ApiRequestOptions = {}
  ) {
    return request<{ items: ProxyPoolItem[]; total: number; page: number; pageSize: number }>(
      http.get(base, { params: query, signal: options.signal })
    );
  },
  countries(options: ApiRequestOptions = {}) {
    return request<{ items: string[] }>(http.get(`${base}/countries`, { signal: options.signal }));
  },
  detail(id: string) {
    return request<RechargeProxyDetail>(http.get(`${base}/${id}`));
  },
  create(input: RechargeProxyWrite) {
    return withV2QueryInvalidation(request<{ id: string }>(http.post(base, input)), [
      'auto-recharge',
      'online-recharge'
    ]);
  },
  importMany(proxies: RechargeProxyWrite[]) {
    return withV2QueryInvalidation(
      request<{ imported: number; duplicates?: number }>(http.post(`${base}/import`, { proxies })),
      ['auto-recharge', 'online-recharge']
    );
  },
  update(
    id: string,
    input: Partial<RechargeProxyWrite> & {
      status?: 'active' | 'disabled';
      expectedUpdatedAt?: string;
    }
  ) {
    return withV2QueryInvalidation(request<{ id: string }>(http.patch(`${base}/${id}`, input)), [
      'auto-recharge',
      'online-recharge'
    ]);
  },
  test(id?: string) {
    return request<{ tasks: unknown[] }>(
      http.post('/id-business-v2/online-recharge/admin/proxies/test', {
        ...(id ? { id } : {}),
        proxyPoolReference: true
      })
    );
  },
  delete(id: string) {
    return withV2QueryInvalidation(request<{ id: string }>(http.delete(`${base}/${id}`)), [
      'auto-recharge',
      'online-recharge'
    ]);
  }
};

export const rechargeProxyApi = {
  ...proxyPoolApi,
  list(query: Parameters<typeof proxyPoolApi.list>[0], options: ApiRequestOptions = {}) {
    return proxyPoolApi.list({ ...query, completeOnly: 'true' }, options) as Promise<{
      items: RechargeProxyItem[];
      total: number;
      page: number;
      pageSize: number;
    }>;
  }
};

export async function readActiveRechargeProxies(signal?: AbortSignal) {
  const items: RechargeProxyItem[] = [];
  for (let page = 1; ; page++) {
    const result = await rechargeProxyApi.list(
      { page, pageSize: 100, status: 'active' },
      { signal }
    );
    items.push(...result.items);
    if (items.length >= result.total || !result.items.length) return { items };
  }
}
