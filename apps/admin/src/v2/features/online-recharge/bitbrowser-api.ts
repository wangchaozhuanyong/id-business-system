import { http, request } from '@/api/client';
import { withV2QueryInvalidation } from '@/v2/composables/useV2Query';
const base = '/id-business-v2/online-recharge/admin/bitbrowser';
export interface BitbrowserDevice {
  activeTask?: { id: string; stage: string } | null;
  id: string;
  name: string;
  enabled: boolean;
  paired: boolean;
  online: boolean;
  ready: boolean;
  busy: boolean;
  protocol: number;
  lastSeenAt: string | null;
  pairingExpiresAt?: string | null;
}
export interface BitbrowserPairing {
  deviceId: string;
  pairingToken: string;
  expiresAt: string;
}
export interface BitbrowserDeviceConnection {
  version: number;
  localApiUrl: string;
  groupName: string;
  tagName: string;
  secretSaved: boolean;
}
export const bitbrowserApi = {
  devices(signal?: AbortSignal) {
    return request<{ items: BitbrowserDevice[] }>(http.get(`${base}/devices`, { signal }));
  },
  device(signal?: AbortSignal) {
    return request<BitbrowserDevice | null>(http.get(`${base}/device`, { signal }));
  },
  pair(name: string, deviceId?: string) {
    return withV2QueryInvalidation(
      request<BitbrowserPairing>(
        http.post(`${base}/device/pairing`, { name, ...(deviceId ? { deviceId } : {}) })
      ),
      'online-recharge'
    );
  },
  revoke(deviceId: string) {
    return withV2QueryInvalidation(
      request(http.post(`${base}/device/revoke`, { deviceId })),
      'online-recharge'
    );
  },
  connection(deviceId: string, signal?: AbortSignal) {
    return request<BitbrowserDeviceConnection>(
      http.get(`${base}/device/${deviceId}/connection`, { signal })
    );
  },
  saveConnection(
    deviceId: string,
    input: Omit<BitbrowserDeviceConnection, 'secretSaved'> & { localApiToken: string }
  ) {
    return withV2QueryInvalidation(
      request(http.post(`${base}/device/${deviceId}/connection`, input)),
      'online-recharge'
    );
  },
  resume(taskId: string) {
    return withV2QueryInvalidation(
      request(http.post(`${base}/tasks/${taskId}/resume`, {})),
      'online-recharge'
    );
  },
  confirm(taskId: string, quoteDigest: string, version: number) {
    return withV2QueryInvalidation(
      request(http.post(`${base}/tasks/${taskId}/confirm`, { quoteDigest, version })),
      'online-recharge'
    );
  }
};
