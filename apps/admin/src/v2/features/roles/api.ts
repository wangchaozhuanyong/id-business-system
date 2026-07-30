import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  CreateV2RoleInput,
  UpdateV2RoleInput,
  V2RoleDetail,
  V2RoleListQuery,
  V2RolesBootstrap
} from './contracts';

export const v2RolesApi = {
  bootstrap(params: V2RoleListQuery, options: ApiRequestOptions = {}) {
    return request<V2RolesBootstrap>(
      http.get('/v2/roles/bootstrap', {
        params,
        signal: options.signal
      })
    );
  },
  get(id: string, options: ApiRequestOptions = {}) {
    return request<V2RoleDetail>(
      http.get(`/v2/roles/${id}`, {
        signal: options.signal
      })
    );
  },
  create(input: CreateV2RoleInput) {
    return request<V2RoleDetail>(http.post('/v2/roles', input));
  },
  update(id: string, input: UpdateV2RoleInput) {
    return request<V2RoleDetail>(http.patch(`/v2/roles/${id}`, input));
  }
};
