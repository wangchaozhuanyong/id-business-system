import { http, request } from '@/api/client';

export interface V2BusinessTimeResult {
  now: string;
  timezone: 'Asia/Shanghai';
}

export const idBusinessV2TimeApi = {
  get(options: { signal?: AbortSignal } = {}) {
    return request<V2BusinessTimeResult>(
      http.get('/id-business-v2/time', {
        signal: options.signal
      })
    );
  }
};
