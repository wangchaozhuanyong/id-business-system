import { http, request, type ApiRequestOptions } from '@/api/client';
import type { AutoRegistrationStatus, AutoRegistrationWorkspaceSession } from './contracts';

const base = '/id-business-v2/auto-registration';

export const autoRegistrationApi = {
  status(options: ApiRequestOptions = {}) {
    return request<AutoRegistrationStatus>(http.get(`${base}/status`, { signal: options.signal }));
  },
  workspaceSession(options: ApiRequestOptions = {}) {
    return request<AutoRegistrationWorkspaceSession>(
      http.post(`${base}/workspace-session`, {}, { signal: options.signal })
    );
  }
};
