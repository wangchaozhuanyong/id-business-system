import { http, request, type ApiRequestOptions } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
import type { V2RechargeBrowserRestore } from '@apple-business/shared';
import { connectorRequest, requireConnectorHealth } from './connector-transport';
import type {
  ImportV2RechargeAddressesResult,
  V2RechargeAddress,
  V2RechargeAddressList,
  V2RechargeAddressListQuery,
  V2RechargeAddressStatus,
  V2RechargeJob,
  V2RechargeBitBrowserSettings,
  V2RechargeBrowserCatalog,
  V2RechargeBrowserCatalogAccess,
  UpdateV2RechargeBitBrowserSettingsInput,
  V2RechargeBitBrowserStart,
  V2RechargeBitBrowserLaunch,
  V2RechargeBitBrowserOpenStart,
  V2RechargeBitBrowserOpenLaunch,
  V2RechargeBitBrowserRecheckStart,
  V2RechargeBitBrowserRecheckLaunch,
  V2RechargeResolveNoBankRequest,
  V2RechargeBitBrowserResolutionLaunch,
  V2RechargeNextCycleConfirmation,
  V2RechargeNextCyclePreparationResult
} from './contracts';
const base = '/id-business-v2/auto-recharge/jobs';
export const rechargeApi = {
  loginCode(
    id: string,
    input: { accountId: string; kind: 'email' | 'totp'; challengeId: string },
    options: ApiRequestOptions = {}
  ) {
    return request<{
      pending: boolean;
      token?: string;
      expiresAt?: string;
      kind?: 'email' | 'totp';
      challengeId?: string;
    }>(http.post(`${base}/${id}/login-code`, input, { signal: options.signal }));
  },
  resolveDeclined(id: string, verificationJobId: string) {
    return withV2QueryInvalidation(
      request<{ id: string; alreadyResolved: boolean }>(
        http.post(`${base}/${id}/resolve-declined`, { confirmNoDebit: true, verificationJobId })
      ),
      'auto-recharge'
    );
  },
  review(query: import('./contracts').V2RechargeReviewQuery, options: ApiRequestOptions = {}) {
    return request<import('./contracts').V2RechargeReviewPage>(
      http.get(`${base}/review`, { params: query, signal: options.signal })
    );
  },
  cancelServer(id: string) {
    return request<{ id: string }>(http.post(`${base}/${id}/cancel`, {}));
  },
  list(options: ApiRequestOptions = {}) {
    return request<{ items: V2RechargeJob[]; configured: boolean; subscriptionCycleProtocol?: 1 }>(
      http.get(base, { signal: options.signal })
    );
  },
  getBitBrowserSettings(options: ApiRequestOptions = {}, connectionProfileId?: string | null) {
    return request<V2RechargeBitBrowserSettings>(
      http.get('/id-business-v2/auto-recharge/bitbrowser-settings', {
        signal: options.signal,
        params:
          connectionProfileId === undefined
            ? undefined
            : { connectionProfileId: connectionProfileId ?? 'default' }
      })
    );
  },
  browserCatalogAccess(
    options: ApiRequestOptions = {},
    directMode = false,
    connectionProfileId?: string | null
  ) {
    return request<V2RechargeBrowserCatalogAccess>(
      http.post(
        '/id-business-v2/auto-recharge/bitbrowser-catalog-access',
        {
          ...(directMode ? { directMode: true } : {}),
          ...(connectionProfileId === undefined ? {} : { connectionProfileId })
        },
        { signal: options.signal }
      )
    );
  },
  updateBitBrowserSettings(input: UpdateV2RechargeBitBrowserSettingsInput) {
    return withV2QueryInvalidation(
      request<V2RechargeBitBrowserSettings>(
        http.put('/id-business-v2/auto-recharge/bitbrowser-settings', input)
      ),
      'auto-recharge'
    );
  },
  startBitBrowser(input: V2RechargeBitBrowserStart) {
    return request<V2RechargeBitBrowserLaunch>(http.post(`${base}/bitbrowser`, input));
  },
  startBitBrowserOpen(input: V2RechargeBitBrowserOpenStart) {
    return request<V2RechargeBitBrowserOpenLaunch>(http.post(`${base}/bitbrowser-open`, input));
  },
  directBrowserCallback(
    id: string,
    agentToken: string,
    input: object,
    options: ApiRequestOptions = {}
  ) {
    return request<Partial<V2RechargeBrowserRestore> & { ok?: true }>(
      http.post(`/id-business-v2/auto-recharge/local/${id}`, input, {
        headers: { 'X-Recharge-Local': agentToken },
        signal: options.signal
      })
    );
  },
  recheckBitBrowser(input: V2RechargeBitBrowserRecheckStart) {
    return request<V2RechargeBitBrowserRecheckLaunch>(
      http.post(`${base}/bitbrowser-recheck`, input)
    );
  },
  resolveNoBankRequest(id: string, input: V2RechargeResolveNoBankRequest) {
    return request<V2RechargeBitBrowserResolutionLaunch | { id: string; alreadyResolved: true }>(
      http.post(`${base}/${id}/resolve-no-bank-request`, input)
    );
  },
  cancelBitBrowser(id: string, options: ApiRequestOptions = {}) {
    return request<{ id: string }>(
      http.post(`${base}/${id}/bitbrowser-cancel`, {}, { signal: options.signal })
    );
  },
  abandonUnreceivedBitBrowser(id: string) {
    return request<{ id: string }>(http.post(`${base}/${id}/bitbrowser-unreceived`, {}));
  },
  confirmNextCycle(
    id: string,
    input: V2RechargeNextCycleConfirmation,
    options: ApiRequestOptions = {}
  ) {
    return request<V2RechargeNextCyclePreparationResult>(
      http.post(`${base}/${id}/next-cycle-confirm`, input, { signal: options.signal })
    );
  },
  bitBrowserAccess(id: string, options: ApiRequestOptions = {}) {
    return request<{ connectorUrl: string; connectorToken: string }>(
      http.post(`${base}/${id}/bitbrowser-access`, {}, { signal: options.signal })
    );
  },
  listAddresses(query: V2RechargeAddressListQuery, options: ApiRequestOptions = {}) {
    return request<V2RechargeAddressList>(
      http.get('/id-business-v2/auto-recharge/addresses', {
        params: query,
        signal: options.signal
      })
    );
  },
  generateAddresses(count = 10) {
    return request<{ count: number; items: V2RechargeAddress[] }>(
      http.post('/id-business-v2/auto-recharge/addresses/generate', { count })
    );
  },
  importAddresses(streets: string[]) {
    return request<ImportV2RechargeAddressesResult>(
      http.post('/id-business-v2/auto-recharge/addresses/import', { streets })
    );
  },
  updateAddressStatus(id: string, status: V2RechargeAddressStatus) {
    return request<V2RechargeAddress>(
      http.patch(`/id-business-v2/auto-recharge/addresses/${id}/status`, { status })
    );
  }
};

export function rechargeCallbackUrl(id: string) {
  const baseUrl = String(http.defaults.baseURL ?? '/api').replace(/\/$/, '');
  const api = new URL(baseUrl.startsWith('http') ? baseUrl : baseUrl, window.location.origin);
  return new URL(
    `${api.pathname.replace(/\/$/, '')}/id-business-v2/auto-recharge/local/${id}`,
    api.origin
  ).toString();
}

export const rechargeConnectorApi = {
  async browserCatalog(
    access: V2RechargeBrowserCatalogAccess,
    signal: AbortSignal
  ): Promise<V2RechargeBrowserCatalog> {
    const result = await connectorRequest(access.connectorUrl, '/browser/catalog', {
      token: access.connectorToken,
      body: { localApiUrl: access.localApiUrl, localApiToken: access.localApiToken },
      signal,
      timeout: 60_000
    });
    const validOptions = (value: unknown): value is V2RechargeBrowserCatalog['groups'] =>
      Array.isArray(value) &&
      value.length <= 2000 &&
      value.every(
        (item) =>
          item &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          item.name.length <= 80
      );
    if (!validOptions(result.groups) || !validOptions(result.tags))
      throw new Error('分组与标签列表格式无效，请刷新重试');
    return { groups: result.groups, tags: result.tags };
  },
  async health(connectorUrl: string, signal?: AbortSignal, allowBusy = false) {
    return requireConnectorHealth(await connectorRequest(connectorUrl, '/health', { signal }), {
      allowBusy
    });
  },
  start(connectorUrl: string, connectorToken: string, body: object) {
    return connectorRequest(connectorUrl, '/jobs', { token: connectorToken, body });
  },
  status(connectorUrl: string, connectorToken: string, id: string) {
    return connectorRequest(connectorUrl, `/jobs/${id}`, {
      token: connectorToken,
      method: 'GET'
    });
  },
  confirm(
    connectorUrl: string,
    connectorToken: string,
    id: string,
    nonce: string,
    quoteDigest: string
  ) {
    return connectorRequest(connectorUrl, `/jobs/${id}/confirm`, {
      token: connectorToken,
      body: { nonce, quoteDigest }
    });
  },
  resume(connectorUrl: string, connectorToken: string, id: string) {
    return connectorRequest(connectorUrl, `/jobs/${id}/resume`, {
      token: connectorToken,
      body: {}
    });
  },
  submitCode(
    connectorUrl: string,
    connectorToken: string,
    id: string,
    code: string,
    expiresAt?: string,
    options: { signal?: AbortSignal; kind?: 'email' | 'totp'; challengeId?: string } = {}
  ) {
    return connectorRequest(connectorUrl, `/jobs/${id}/code`, {
      token: connectorToken,
      signal: options.signal,
      body: {
        code,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(options.kind ? { kind: options.kind, challengeId: options.challengeId } : {})
      }
    });
  },
  cancel(connectorUrl: string, connectorToken: string, id: string) {
    return connectorRequest(connectorUrl, `/jobs/${id}/cancel`, {
      token: connectorToken,
      body: {}
    });
  }
};
