import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  V2ActiveSessionRecord,
  V2IpWhitelistListQuery,
  V2IpWhitelistRecord,
  V2LoginLogListQuery,
  V2LoginLogRecord,
  V2MfaRecoveryCodesResult,
  V2MfaSettings,
  V2MfaSetupResult,
  V2MfaStatus,
  V2MfaUserListQuery,
  V2MfaUserRecord,
  V2PagedResult,
  V2SaveIpWhitelistInput,
  V2SecurityOverview,
  V2SessionListQuery,
  V2UpdateMfaSettingsInput,
  V2VerifyMfaInput,
  V2DisableMfaInput
} from './contracts';

export const v2SecurityApi = {
  overview(options: ApiRequestOptions = {}) {
    return request<V2SecurityOverview>(
      http.get('/v2/security/overview', { signal: options.signal })
    );
  },
  listLoginLogs(query: V2LoginLogListQuery, options: ApiRequestOptions = {}) {
    return request<V2PagedResult<V2LoginLogRecord>>(
      http.get('/v2/security/login-logs', { params: query, signal: options.signal })
    );
  },
  listSessions(query: V2SessionListQuery, options: ApiRequestOptions = {}) {
    return request<V2PagedResult<V2ActiveSessionRecord>>(
      http.get('/v2/security/sessions', { params: query, signal: options.signal })
    );
  },
  revokeSession(id: string) {
    return request<V2ActiveSessionRecord>(http.post(`/v2/security/sessions/${id}/revoke`));
  },
  getMfaSettings(options: ApiRequestOptions = {}) {
    return request<V2MfaSettings>(
      http.get('/v2/security/mfa/settings', { signal: options.signal })
    );
  },
  getMyMfaStatus(options: ApiRequestOptions = {}) {
    return request<V2MfaStatus>(http.get('/v2/security/mfa/my-status', { signal: options.signal }));
  },
  updateMfaSettings(input: V2UpdateMfaSettingsInput) {
    return request<V2MfaSettings>(http.patch('/v2/security/mfa/settings', input));
  },
  setupMyMfa() {
    return request<V2MfaSetupResult>(http.post('/v2/security/mfa/my-setup'));
  },
  enableMyMfa(input: V2VerifyMfaInput) {
    return request<V2MfaRecoveryCodesResult>(http.post('/v2/security/mfa/my-enable', input));
  },
  regenerateMyMfaRecoveryCodes(input: V2VerifyMfaInput) {
    return request<V2MfaRecoveryCodesResult>(
      http.post('/v2/security/mfa/my-recovery-codes', input)
    );
  },
  disableMyMfa(input: V2DisableMfaInput) {
    return request<V2MfaStatus>(http.post('/v2/security/mfa/my-disable', input));
  },
  listMfaUsers(query: V2MfaUserListQuery, options: ApiRequestOptions = {}) {
    return request<V2PagedResult<V2MfaUserRecord>>(
      http.get('/v2/security/mfa/users', { params: query, signal: options.signal })
    );
  },
  resetUserMfa(id: string) {
    return request<V2MfaStatus>(http.post(`/v2/security/mfa/users/${id}/reset`));
  },
  listIpWhitelists(query: V2IpWhitelistListQuery, options: ApiRequestOptions = {}) {
    return request<V2PagedResult<V2IpWhitelistRecord>>(
      http.get('/v2/security/ip-whitelists', { params: query, signal: options.signal })
    );
  },
  createIpWhitelist(input: V2SaveIpWhitelistInput) {
    return request<V2IpWhitelistRecord>(http.post('/v2/security/ip-whitelists', input));
  },
  updateIpWhitelist(id: string, input: V2SaveIpWhitelistInput) {
    return request<V2IpWhitelistRecord>(http.patch(`/v2/security/ip-whitelists/${id}`, input));
  },
  removeIpWhitelist(id: string) {
    return request<{ deleted: true }>(http.delete(`/v2/security/ip-whitelists/${id}`));
  }
};
