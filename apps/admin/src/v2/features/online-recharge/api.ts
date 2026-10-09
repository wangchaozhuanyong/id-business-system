import axios from 'axios';
import { http, request } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type { OnlineList, OnlineQuery, OnlineSection, PublicConfig, PublicTask } from './contracts';
const base = '/id-business-v2/online-recharge';
const publicHttp = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 20000
});
// 独立客户客户端，不附加后台登录凭据，也不触发后台会话失效处理。
async function customerRequest<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const result =
    body === undefined
      ? await publicHttp.get(`${base}/public/${path}`, { signal })
      : await publicHttp.post(`${base}/public/${path}`, body, { signal });
  const payload = result.data;
  if (payload?.success === false) throw new Error(payload.message || '请求失败，请稍后重试');
  return payload?.data ?? payload;
}
export const onlineApi = {
  list(section: OnlineSection, params: OnlineQuery, signal?: AbortSignal) {
    return request<OnlineList>(http.get(`${base}/admin/${section}`, { params, signal }));
  },
  overview(signal?: AbortSignal) {
    return request<Record<string, unknown>>(http.get(`${base}/admin/overview`, { signal }));
  },
  config(signal?: AbortSignal) {
    return request<Record<string, unknown>>(http.get(`${base}/admin/config`, { signal }));
  },
  saveConfig(body: object) {
    return withV2QueryInvalidation(
      request<Record<string, unknown>>(http.patch(`${base}/admin/config`, body)),
      'online-recharge'
    );
  },
  action(section: OnlineSection, action: string, body: object = {}) {
    const result = request<Record<string, unknown>>(
      http.post(`${base}/admin/${section}/${action}`, body)
    );
    return ['detail', 'reveal', 'summary', 'artifacts', 'subscribe', 'export'].includes(action)
      ? result
      : withV2QueryInvalidation(result, 'online-recharge');
  },
  async publicConfig(signal?: AbortSignal): Promise<PublicConfig> {
    const result = await customerRequest<
      PublicConfig & {
        maintenance?: boolean;
        maxConcurrent?: number;
        active?: number;
        paymentRegion?: string;
      }
    >('config', undefined, signal);
    return {
      ...result,
      maintenanceMode: result.maintenanceMode ?? result.maintenance,
      capacity: result.capacity ?? result.maxConcurrent,
      activeJobs: result.activeJobs ?? result.active,
      region: result.region ?? result.paymentRegion
    };
  },
  verify(code: string) {
    return customerRequest<{ plan: string; status: string; taskId?: string }>('verify', { code });
  },
  redeem(code: string, session: string) {
    return customerRequest<PublicTask>('redeem', { code, session });
  },
  task(id: string, taskToken: string, signal?: AbortSignal) {
    return customerRequest<PublicTask>('task', { id, taskToken }, signal);
  },
  query(code: string) {
    return customerRequest<{ task?: PublicTask; taskToken?: string }>('query', { code });
  },
  publicSubscribe(id: string, taskToken: string) {
    return customerRequest<{ ticket: string; wsPath: string }>('subscribe', { id, taskToken });
  },
  subscription(session: string) {
    return customerRequest<PublicTask>('subscription', { session });
  }
};
export async function copyOnlineText(value: string) {
  await navigator.clipboard.writeText(value);
}
export function downloadOnlineText(text: string, name: string, type = 'text/plain;charset=utf-8') {
  const blob = new Blob(['\uFEFF', text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
