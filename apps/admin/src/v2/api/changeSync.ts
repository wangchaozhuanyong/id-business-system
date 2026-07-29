import type { V2ChangeVersionsResult } from '@apple-business/shared';
import { http, request } from '@/api/client';

export const idBusinessV2ChangeSyncApi = {
  getVersions(options: { signal?: AbortSignal } = {}) {
    return request<V2ChangeVersionsResult>(
      http.get('/id-business-v2/change-versions', {
        signal: options.signal
      })
    );
  }
};
