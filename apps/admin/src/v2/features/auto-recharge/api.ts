import { http, request, type ApiRequestOptions } from '@/api/client';
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
  V2RechargeBitBrowserRecheckStart,
  V2RechargeBitBrowserRecheckLaunch
} from './contracts';
const base = '/id-business-v2/auto-recharge/jobs';
export const rechargeApi = {
  list(options: ApiRequestOptions = {}) {
    return request<{ items: V2RechargeJob[]; configured: boolean }>(
      http.get(base, { signal: options.signal })
    );
  },
  getBitBrowserSettings(options: ApiRequestOptions = {}) {
    return request<V2RechargeBitBrowserSettings>(
      http.get('/id-business-v2/auto-recharge/bitbrowser-settings', {
        signal: options.signal
      })
    );
  },
  browserCatalogAccess(options: ApiRequestOptions = {}) {
    return request<V2RechargeBrowserCatalogAccess>(
      http.post(
        '/id-business-v2/auto-recharge/bitbrowser-catalog-access',
        {},
        { signal: options.signal }
      )
    );
  },
  updateBitBrowserSettings(input: UpdateV2RechargeBitBrowserSettingsInput) {
    return request<V2RechargeBitBrowserSettings>(
      http.put('/id-business-v2/auto-recharge/bitbrowser-settings', input)
    );
  },
  startBitBrowser(input: V2RechargeBitBrowserStart) {
    return request<V2RechargeBitBrowserLaunch>(http.post(`${base}/bitbrowser`, input));
  },
  recheckBitBrowser(input: V2RechargeBitBrowserRecheckStart) {
    return request<V2RechargeBitBrowserRecheckLaunch>(
      http.post(`${base}/bitbrowser-recheck`, input)
    );
  },
  cancelBitBrowser(id: string) {
    return request<{ id: string }>(http.post(`${base}/${id}/bitbrowser-cancel`, {}));
  },
  abandonUnreceivedBitBrowser(id: string) {
    return request<{ id: string }>(http.post(`${base}/${id}/bitbrowser-unreceived`, {}));
  },
  bitBrowserAccess(id: string) {
    return request<{ connectorUrl: string; connectorToken: string }>(
      http.post(`${base}/${id}/bitbrowser-access`, {})
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
  async health(connectorUrl: string, signal?: AbortSignal) {
    return requireConnectorHealth(await connectorRequest(connectorUrl, '/health', { signal }));
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
  resume(connectorUrl: string, connectorToken: string, id: string) {
    return connectorRequest(connectorUrl, `/jobs/${id}/resume`, {
      token: connectorToken,
      body: {}
    });
  },
  cancel(connectorUrl: string, connectorToken: string, id: string) {
    return connectorRequest(connectorUrl, `/jobs/${id}/cancel`, {
      token: connectorToken,
      body: {}
    });
  }
};
