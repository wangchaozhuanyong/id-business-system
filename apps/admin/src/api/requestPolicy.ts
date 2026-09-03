const TRANSIENT_STATUSES = new Set([502, 503, 504]);

export interface ApiRequestPolicy {
  retryDelaysMs: readonly number[];
  timeoutMs: number;
}

export interface ApiEndpointPolicy {
  bypassSessionGate: boolean;
  key:
    | 'auth-login'
    | 'auth-logout'
    | 'auth-change-password'
    | 'auth-refresh'
    | 'health'
    | 'public-branding'
    | 'public-mailbox'
    | 'public-maintenance'
    | 'ordinary';
}

interface RetryDelayInput {
  aborted?: boolean;
  isNetworkError: boolean;
  method?: string;
  random?: () => number;
  retryCount: number;
  status?: number;
  url?: string;
}

const AUTH_ME_POLICY: ApiRequestPolicy = {
  retryDelaysMs: [200, 800],
  timeoutMs: 8_000
};

const BUSINESS_READ_POLICY: ApiRequestPolicy = {
  retryDelaysMs: [200, 800],
  timeoutMs: 15_000
};

const MEDIA_DOWNLOAD_POLICY: ApiRequestPolicy = {
  retryDelaysMs: [],
  timeoutMs: 390_000
};

const RELAY_REMOTE_WRITE_POLICY: ApiRequestPolicy = {
  retryDelaysMs: [],
  timeoutMs: 115_000
};

const ENDPOINT_POLICIES = new Map<string, ApiEndpointPolicy>([
  ['/auth/login', { bypassSessionGate: true, key: 'auth-login' }],
  ['/auth/logout', { bypassSessionGate: true, key: 'auth-logout' }],
  ['/auth/change-password', { bypassSessionGate: true, key: 'auth-change-password' }],
  ['/auth/refresh', { bypassSessionGate: true, key: 'auth-refresh' }],
  ['/health/ready', { bypassSessionGate: true, key: 'health' }],
  ['/health/live', { bypassSessionGate: true, key: 'health' }],
  ['/id-business-v2/branding/public', { bypassSessionGate: true, key: 'public-branding' }],
  ['/public/mailbox/query', { bypassSessionGate: true, key: 'public-mailbox' }],
  ['/maintenance/mode/public', { bypassSessionGate: true, key: 'public-maintenance' }]
]);

const ORDINARY_ENDPOINT_POLICY: ApiEndpointPolicy = {
  bypassSessionGate: false,
  key: 'ordinary'
};

export function getApiEndpointPolicy(url?: string): ApiEndpointPolicy {
  const pathname = normalizePathname(url);
  if (pathname.startsWith('data:') || pathname.startsWith('blob:')) {
    return { bypassSessionGate: true, key: 'ordinary' };
  }
  return ENDPOINT_POLICIES.get(pathname) ?? ORDINARY_ENDPOINT_POLICY;
}

export function getApiRequestPolicy(method?: string, url?: string): ApiRequestPolicy | null {
  const pathname = normalizePathname(url);
  if (method?.toLowerCase() !== 'get' && pathname.startsWith('/id-business-v2/workspace-relay/')) {
    return RELAY_REMOTE_WRITE_POLICY;
  }
  if (method?.toLowerCase() !== 'get') return null;
  if (pathname === '/auth/me') return AUTH_ME_POLICY;
  if (pathname === '/id-business-v2/workspace-media/download') return MEDIA_DOWNLOAD_POLICY;
  if (
    pathname.startsWith('/id-business-v2/') ||
    pathname.startsWith('/v2/') ||
    pathname.startsWith('/audit-logs')
  ) {
    return BUSINESS_READ_POLICY;
  }
  return null;
}

export function getApiRequestRetryDelay(input: RetryDelayInput) {
  if (input.aborted) return null;
  const policy = getApiRequestPolicy(input.method, input.url);
  if (!policy) return null;
  if (!input.isNetworkError && !TRANSIENT_STATUSES.has(input.status ?? 0)) return null;

  const baseDelay = policy.retryDelaysMs[input.retryCount];
  if (baseDelay === undefined) return null;
  const random = input.random?.() ?? Math.random();
  return Math.round(baseDelay * (0.8 + Math.min(1, Math.max(0, random)) * 0.4));
}

function normalizePathname(url?: string) {
  const value = String(url ?? '').trim();
  if (!value) return '';
  try {
    return new URL(value, 'https://local.invalid').pathname;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}
