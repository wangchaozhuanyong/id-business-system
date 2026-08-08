import type {
  ResetV2TablePreferenceResult,
  UpdateV2TablePreferenceInput,
  V2TablePreference,
  V2TablePreferenceList
} from '@apple-business/shared';
import { http, request, type ApiRequestOptions } from '@/api/client';

export const idBusinessV2TablePreferencesApi = {
  list(options: ApiRequestOptions = {}) {
    return request<V2TablePreferenceList>(
      http.get('/id-business-v2/table-preferences', { signal: options.signal })
    );
  },
  update(tableId: string, input: UpdateV2TablePreferenceInput) {
    return request<V2TablePreference>(
      http.put(`/id-business-v2/table-preferences/${encodeURIComponent(tableId)}`, input)
    );
  },
  reset(tableId: string) {
    return request<ResetV2TablePreferenceResult>(
      http.delete(`/id-business-v2/table-preferences/${encodeURIComponent(tableId)}`)
    );
  }
};
