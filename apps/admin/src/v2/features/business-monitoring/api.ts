import { http, request, type ApiRequestOptions } from '@/api/client';
import type { V2BusinessMonitoringListQuery, V2BusinessMonitoringResponse } from './contracts';

export const v2BusinessMonitoringApi = {
  findings(params: V2BusinessMonitoringListQuery, options: ApiRequestOptions = {}) {
    return request<V2BusinessMonitoringResponse>(
      http.get('/id-business-v2/business-monitoring/findings', {
        params,
        signal: options.signal
      })
    );
  }
};
