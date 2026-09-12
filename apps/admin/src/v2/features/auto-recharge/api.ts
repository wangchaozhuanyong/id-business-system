import { http, request, type ApiRequestOptions } from '@/api/client';
import type {
  ImportV2RechargeAddressesResult,
  V2RechargeAddress,
  V2RechargeAddressList,
  V2RechargeAddressListQuery,
  V2RechargeAddressStatus,
  V2RechargeJob,
  V2RechargeBitBrowserSettings,
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

async function connectorRequest(
  connectorUrl: string,
  path: string,
  options: { token?: string; body?: object; method?: 'GET' | 'POST' } = {}
) {
  const response = await fetch(connectorUrl.replace(/\/$/, '') + path, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    mode: 'cors',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { 'X-Auto-Recharge-Connector': options.token } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000)
  });
  const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || result.ok !== true) throw new Error('本机连接器未接受请求');
  return result;
}

export const rechargeConnectorApi = {
  health(connectorUrl: string) {
    return connectorRequest(connectorUrl, '/health');
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
