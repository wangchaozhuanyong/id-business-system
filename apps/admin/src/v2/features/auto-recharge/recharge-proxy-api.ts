import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type { ProxyKind } from './recharge-proxy-options';

const base = '/id-business-v2/auto-recharge/proxies';

export interface RechargeProxyItem {
  id: string;
  countryCode: string;
  kind: ProxyKind;
  connectionMode: 'extraction' | 'direct';
  protocol: 'http' | 'https' | 'socks5';
  linkMask: string;
  status: 'active' | 'disabled';
  remark1: string | null;
  remark2: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RechargeProxyDetail extends Omit<
  RechargeProxyItem,
  'linkMask' | 'connectionMode' | 'protocol' | 'createdAt' | 'updatedAt'
> {
  url: string;
}

export interface RechargeProxyWrite {
  countryCode: string;
  url: string;
  kind: ProxyKind;
  remark1: string;
  remark2: string;
}

export const rechargeProxyApi = {
  list(
    query: {
      page: number;
      pageSize: number;
      keyword?: string;
      countryCode?: string;
      kind?: string;
      status?: string;
    },
    options: ApiRequestOptions = {}
  ) {
    return request<{ items: RechargeProxyItem[]; total: number; page: number; pageSize: number }>(
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
    return withV2QueryInvalidation(
      request<{ id: string }>(http.post(base, input)),
      'auto-recharge'
    );
  },
  importMany(proxies: RechargeProxyWrite[]) {
    return withV2QueryInvalidation(
      request<{ imported: number }>(http.post(`${base}/import`, { proxies })),
      'auto-recharge'
    );
  },
  update(id: string, input: Partial<RechargeProxyWrite> & { status?: 'active' | 'disabled' }) {
    return withV2QueryInvalidation(
      request<{ id: string }>(http.patch(`${base}/${id}`, input)),
      'auto-recharge'
    );
  },
  delete(id: string) {
    return withV2QueryInvalidation(
      request<{ id: string }>(http.delete(`${base}/${id}`)),
      'auto-recharge'
    );
  }
};
