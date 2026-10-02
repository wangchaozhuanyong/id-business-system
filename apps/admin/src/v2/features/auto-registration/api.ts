import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type {
  V2RegistrationName,
  V2RegistrationJob,
  V2RegistrationStart,
  V2RegistrationPage
} from './contracts';
const base = '/id-business-v2/auto-registration';
export interface RegistrationOptions {
  mailboxes: Array<{ id: string; email: string }>;
  proxies: Array<{ id: string; label: string; countryCode: string }>;
  names: Array<{ id: string; displayName: string }>;
  mailboxTotal: number;
  proxyTotal: number;
}
export interface RegistrationLaunch extends Record<string, unknown> {
  id: string;
  mode: 'registration';
  attempt: number;
  agentToken: string;
  connectorUrl: string;
  connectorToken: string;
}
export const registrationApi = {
  connection() {
    return request<{ connectorUrl: string; connectorToken: string }>(
      http.get(`${base}/connection`)
    );
  },
  names(
    query: { page: number; pageSize: number; keyword?: string; status?: string },
    options: ApiRequestOptions = {}
  ) {
    return request<V2RegistrationPage<V2RegistrationName>>(
      http.get(`${base}/names`, { params: query, signal: options.signal })
    );
  },
  writeName(
    id: string | null,
    input: { displayName: string; active: boolean; expectedUpdatedAt?: string | null }
  ) {
    return withV2QueryInvalidation(
      request<V2RegistrationName>(
        id ? http.patch(`${base}/names/${id}`, input) : http.post(`${base}/names`, input)
      ),
      'auto-recharge'
    );
  },
  importNames(names: string[]) {
    return withV2QueryInvalidation(
      request<{ imported: number; skipped: number }>(http.post(`${base}/names/import`, { names })),
      'auto-recharge'
    );
  },
  options(query: { q?: string; page?: number }, options: ApiRequestOptions = {}) {
    return request<RegistrationOptions>(
      http.get(`${base}/options`, { params: query, signal: options.signal })
    );
  },
  jobs(
    query: { page: number; pageSize: number; keyword?: string },
    options: ApiRequestOptions = {}
  ) {
    return request<V2RegistrationPage<V2RegistrationJob>>(
      http.get(`${base}/jobs`, { params: query, signal: options.signal })
    );
  },
  job(id: string, options: ApiRequestOptions = {}) {
    return request<V2RegistrationJob>(http.get(`${base}/jobs/${id}`, { signal: options.signal }));
  },
  create(input: V2RegistrationStart) {
    return withV2QueryInvalidation(
      request<V2RegistrationJob>(http.post(`${base}/jobs`, input)),
      'auto-recharge'
    );
  },
  launch(id: string) {
    return request<RegistrationLaunch>(http.post(`${base}/jobs/${id}/launch`, {}));
  },
  code(id: string, signal: AbortSignal) {
    return request<{ code: string | null; mailId?: string; attempt?: number; step?: string }>(
      http.post(`${base}/jobs/${id}/code`, {}, { signal })
    );
  },
  resumeCredentials(id: string) {
    return request<{ attempt: number; password: string | null; totpSecret: string | null }>(
      http.post(`${base}/jobs/${id}/resume-credentials`, {})
    );
  },
  cancel(id: string) {
    return withV2QueryInvalidation(
      request<{ id: string }>(http.post(`${base}/jobs/${id}/cancel`, {})),
      'auto-recharge'
    );
  }
};
