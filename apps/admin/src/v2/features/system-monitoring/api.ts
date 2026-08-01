import { http, request, type ApiRequestOptions } from '@/api/client';
import type { V2SystemMonitoringResponse } from './contracts';

export const v2SystemMonitoringApi = {
  overview(options: ApiRequestOptions = {}) {
    return request<V2SystemMonitoringResponse>(
      http.get('/id-business-v2/system-monitoring/overview', { signal: options.signal })
    );
  }
};
