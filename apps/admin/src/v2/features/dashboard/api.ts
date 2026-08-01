import { http, request, type ApiRequestOptions } from '@/api/client';
import type { V2DashboardOverview } from './contracts';

export const v2DashboardApi = {
  overview(options: ApiRequestOptions = {}) {
    return request<V2DashboardOverview>(
      http.get('/id-business-v2/dashboard/overview', { signal: options.signal })
    );
  }
};
