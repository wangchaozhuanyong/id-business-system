import { http, request } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type { OnlineList, OnlineQuery, OnlineSection, PublicConfig, PublicTask } from './contracts';
const base = '/id-business-v2/online-recharge';
// 保留原接口路径；公司内部入口统一使用后台身份及会话失效处理。
function internalRequest<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  return request<T>(
    body === undefined
      ? http.get(`${base}/public/${path}`, { signal })
      : http.post(`${base}/public/${path}`, body, { signal })
  );
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
    return [
      'detail',
      'reveal',
      'summary',
      'artifacts',
      'subscribe',
      'export',
      'order-backfill-preview'
    ].includes(action)
      ? result
      : withV2QueryInvalidation(result, 'online-recharge');
  },
  async publicConfig(signal?: AbortSignal): Promise<PublicConfig> {
    const result = await internalRequest<
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
    return internalRequest<{ plan: string; status: string; taskId?: string }>('verify', { code });
  },
  redeem(code: string, session: string) {
    return internalRequest<PublicTask>('redeem', { code, session });
  },
  task(id: string, taskToken: string, signal?: AbortSignal) {
    return internalRequest<PublicTask>('task', { id, taskToken }, signal);
  },
  query(code: string) {
    return internalRequest<{ task?: PublicTask; taskToken?: string }>('query', { code });
  },
  publicSubscribe(id: string, taskToken: string) {
    return internalRequest<{ ticket: string; wsPath: string }>('subscribe', { id, taskToken });
  },
  subscription(session: string) {
    return internalRequest<PublicTask>('subscription', { session });
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
