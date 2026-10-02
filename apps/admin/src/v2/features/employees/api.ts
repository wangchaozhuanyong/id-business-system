import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  CreateV2EmployeeInput,
  UpdateV2EmployeeInput,
  V2Employee,
  V2EmployeeListQuery,
  V2EmployeesBootstrap
} from './contracts';
import type { V2EmployeeDeletePreview } from './contracts';

export const v2EmployeesApi = {
  bootstrap(params: V2EmployeeListQuery, options: ApiRequestOptions = {}) {
    return request<V2EmployeesBootstrap>(
      http.get('/v2/employees/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  create(input: CreateV2EmployeeInput) {
    return request<V2Employee>(http.post('/v2/employees', input));
  },
  update(id: string, input: UpdateV2EmployeeInput) {
    return request<V2Employee>(http.patch(`/v2/employees/${id}`, input));
  },
  resetPassword(id: string, input: { expectedUpdatedAt: string; newPassword: string }) {
    return request<{ reset: boolean }>(http.post(`/v2/employees/${id}/reset-password`, input));
  },
  deletePreview(id: string, options: ApiRequestOptions = {}) {
    return request<V2EmployeeDeletePreview>(
      http.get(`/v2/employees/${id}/delete-preview`, { signal: options.signal })
    );
  },
  remove(id: string, input: { expectedUpdatedAt: string; previewHash: string }) {
    return request<{ deleted: boolean }>(http.post(`/v2/employees/${id}/delete`, input));
  }
};
