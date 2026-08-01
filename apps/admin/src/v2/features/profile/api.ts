import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  V2ProfileBootstrap,
  V2ProfileMfaRecoveryCodesResult,
  V2ProfileMfaSetupResult,
  V2ProfileMfaStatus,
  V2ProfileSessionListQuery,
  V2ProfileSessionRecord
} from './contracts';

export const v2ProfileApi = {
  bootstrap(query: V2ProfileSessionListQuery, options: ApiRequestOptions = {}) {
    return request<V2ProfileBootstrap>(
      http.get('/v2/profile/bootstrap', { params: query, signal: options.signal })
    );
  },
  revokeSession(id: string) {
    return request<V2ProfileSessionRecord>(http.post(`/v2/profile/sessions/${id}/revoke`));
  },
  revokeOtherSessions() {
    return request<{ revokedCount: number }>(http.post('/v2/profile/sessions/revoke-others'));
  },
  setupMfa() {
    return request<V2ProfileMfaSetupResult>(http.post('/v2/profile/mfa/setup'));
  },
  enableMfa(code: string) {
    return request<V2ProfileMfaRecoveryCodesResult>(http.post('/v2/profile/mfa/enable', { code }));
  },
  regenerateRecoveryCodes(code: string) {
    return request<V2ProfileMfaRecoveryCodesResult>(
      http.post('/v2/profile/mfa/recovery-codes', { code })
    );
  },
  disableMfa(code: string) {
    return request<V2ProfileMfaStatus>(
      http.post('/v2/profile/mfa/disable', { code, reason: 'self_service' })
    );
  }
};
