import type { ApiResponse } from '@apple-business/shared';
import axios, { AxiosError, type GenericAbortSignal, type InternalAxiosRequestConfig } from 'axios';
import { ApiError, isApiError, type ApiErrorKind } from '@/api/apiError';
import type { CredentialSnapshot } from '@/auth/credential';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import {
  getApiEndpointPolicy,
  getApiRequestPolicy,
  getApiRequestRetryDelay
} from './requestPolicy';

export { AUTH_CREDENTIAL_STORAGE_KEY } from '@/auth/credential';

const supabaseFunctionRegion = String(import.meta.env.VITE_SUPABASE_FUNCTION_REGION ?? '').trim();

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 15000
});

export interface ApiRequestOptions {
  signal?: AbortSignal;
}

interface RetryableReadRequestConfig extends InternalAxiosRequestConfig {
  __credentialSnapshot?: CredentialSnapshot | null;
  __requestPolicyRetryCount?: number;
}

const serverMessageMap: Record<string, string> = {
  'Invalid username or password': '账号或密码错误，请检查账号和密码后重试。',
  'MFA code is required': '需要输入动态验证码或恢复码。',
  'MFA code is invalid': '动态验证码或恢复码错误，请重新输入。',
  'MFA is not enabled': '动态验证码还没有开启。',
  'MFA secret is not configured': '动态验证码还没有配置，请先重新绑定。',
  'MFA secret is invalid': '动态验证码配置不正确，请重新绑定。',
  'IP address is not allowed': '当前 IP 不在白名单内，无法登录。',
  'Missing bearer token': '请先登录后再操作。',
  'Session has expired or been revoked': '登录状态已过期或已被下线，请重新登录。',
  'Invalid or expired token': '登录状态无效或已过期，请重新登录。',
  'Permission denied': '没有权限操作，请联系管理员检查角色权限。',
  'Permission check requires authenticated user': '请先登录后再操作。',
  'Export file is not ready': '导出文件还没准备好，请稍后再试。',
  'Export download has expired': '导出文件下载已过期，请重新生成导出任务。',
  'Export file not found': '导出文件不存在或已被清理，请重新生成。',
  'Database is not ready': '数据库还没有准备好，请稍后再试。'
};

const serverTermMap: Record<string, string> = {
  'active session': '在线会话',
  'apple account': 'Apple ID',
  'apple activation': '开通记录',
  'apple id': 'Apple ID',
  'apple id status': 'Apple ID 状态',
  'apple order': 'Apple ID 订单',
  'apple service': 'Apple ID 业务',
  attachment: '附件',
  'attachment file': '附件文件',
  customer: '客户',
  'customer phone': '客户手机号',
  'ip whitelist': 'IP 白名单',
  'notification rule': '续费预警设置',
  'renewal task': '续费任务',
  role: '角色',
  'sensitive access approval': '敏感信息审批',
  user: '用户'
};

http.interceptors.request.use((config) => {
  const requestUrl = String(config.url ?? '');
  const endpointPolicy = getApiEndpointPolicy(requestUrl);
  const bypassAuthGate = endpointPolicy.bypassSessionGate;
  const requestConfig = config as RetryableReadRequestConfig;
  const credentialSnapshot = sessionCoordinator.getCredentialSnapshot();
  requestConfig.__credentialSnapshot = credentialSnapshot;

  const requestPolicy = getApiRequestPolicy(config.method, requestUrl);
  if (requestPolicy) config.timeout = requestPolicy.timeoutMs;

  if (!bypassAuthGate && isWriteMethod(config.method)) {
    sessionCoordinator.assertWriteAllowed();
  }

  if (!bypassAuthGate) {
    config.signal = mergeAbortSignals(config.signal, sessionCoordinator.getRequestAbortSignal());
  }

  if (credentialSnapshot?.token) {
    config.headers.Authorization = `Bearer ${credentialSnapshot.token}`;
  }

  if (supabaseFunctionRegion) {
    config.headers['x-region'] = supabaseFunctionRegion;
  }

  return config;
});

http.interceptors.response.use(
  (response) => {
    const config = response.config as RetryableReadRequestConfig;
    const requestUrl = String(config.url ?? '');
    if (
      !isAuthGateBypassRequest(requestUrl) &&
      !isRequestCredentialCurrent(config.__credentialSnapshot)
    ) {
      throw new DOMException('请求所属的登录身份已变化。', 'AbortError');
    }
    return response;
  },
  async (error: unknown) => {
    if (!axios.isAxiosError(error)) {
      throw error;
    }

    const config = error.config as RetryableReadRequestConfig | undefined;
    const retryCount = config?.__requestPolicyRetryCount ?? 0;
    const delayMs = getApiRequestRetryDelay({
      aborted: config?.signal?.aborted,
      isNetworkError: !error.response,
      method: config?.method,
      retryCount,
      status: error.response?.status,
      url: config?.url
    });

    if (!config || delayMs === null) {
      throw error;
    }

    config.__requestPolicyRetryCount = retryCount + 1;
    await waitForRetry(delayMs, config.signal);

    if (config.signal?.aborted || !isRequestCredentialCurrent(config.__credentialSnapshot)) {
      throw error;
    }

    return http.request(config);
  }
);

export function getApiErrorMessage(error: unknown) {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) {
    return normalizeServerMessage(error.message);
  }

  return '操作失败，请稍后重试。';
}

function isLikelyEnglishMessage(message: string) {
  return (
    /[A-Za-z]/.test(message) &&
    Array.from(message).every((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
    })
  );
}

function normalizeServerTerm(term: string) {
  const normalized = term
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  return serverTermMap[normalized] ?? (isLikelyEnglishMessage(term) ? '参数' : term.trim());
}

function getGenericServerMessage(status?: number) {
  if (status === 400) {
    return '提交内容不正确，请检查后重试。';
  }

  if (status === 401) {
    return '登录状态已过期，请重新登录。';
  }

  if (status === 403) {
    return '没有权限访问该功能，请联系管理员检查角色权限。';
  }

  if (status === 404) {
    return '请求的数据不存在或已被删除。';
  }

  if (status === 409) {
    return '当前数据状态有变化，请刷新后重试。';
  }

  if (status === 502 || status === 503 || status === 504) {
    return `服务暂时不可用（${status}），请稍后重试。`;
  }

  if (status && status >= 500) {
    return `服务器内部错误（${status}），请稍后重试或联系管理员。`;
  }

  return status ? `请求失败，服务器返回 ${status}。` : '操作失败，请稍后重试。';
}

function translateServerMessagePattern(message: string, status?: number) {
  const notFoundMatch = message.match(/^(.+) not found$/i);
  if (notFoundMatch?.[1]) {
    return `${normalizeServerTerm(notFoundMatch[1])}不存在或已被删除。`;
  }

  const alreadyExistsMatch = message.match(/^(.+) already exists$/i);
  if (alreadyExistsMatch?.[1]) {
    return `${normalizeServerTerm(alreadyExistsMatch[1])}已存在。`;
  }

  const disabledMatch = message.match(/^(.+) does not exist or is disabled$/i);
  if (disabledMatch?.[1]) {
    return `${normalizeServerTerm(disabledMatch[1])}不存在或已停用。`;
  }

  const requiredMatch = message.match(/^(.+) is required$/i);
  if (requiredMatch?.[1]) {
    return `请填写${normalizeServerTerm(requiredMatch[1])}。`;
  }

  const invalidPrefixMatch = message.match(/^Invalid (.+)$/i);
  if (invalidPrefixMatch?.[1]) {
    return `${normalizeServerTerm(invalidPrefixMatch[1])}不正确。`;
  }

  const invalidSuffixMatch = message.match(/^(.+) is invalid$/i);
  if (invalidSuffixMatch?.[1]) {
    return `${normalizeServerTerm(invalidSuffixMatch[1])}不正确。`;
  }

  const invalidFormatMatch = message.match(/^(.+) format is invalid$/i);
  if (invalidFormatMatch?.[1]) {
    return `${normalizeServerTerm(invalidFormatMatch[1])}格式不正确。`;
  }

  const mustBeMatch = message.match(/^(.+) must be (.+)$/i);
  if (mustBeMatch?.[1]) {
    return `${normalizeServerTerm(mustBeMatch[1])}格式或取值不正确。`;
  }

  const cannotBeMatch = message.match(/^(.+) cannot be (.+)$/i);
  if (cannotBeMatch?.[1]) {
    return `${normalizeServerTerm(cannotBeMatch[1])}当前不能执行这个操作。`;
  }

  if (isLikelyEnglishMessage(message)) {
    return getGenericServerMessage(status);
  }

  return message;
}

function normalizeServerMessage(message: string, status?: number) {
  const normalized = message.trim();

  if (!normalized) {
    return getGenericServerMessage(status);
  }

  return serverMessageMap[normalized] ?? translateServerMessagePattern(normalized, status);
}

function getAxiosErrorMessage(error: AxiosError<ApiResponse<unknown>>) {
  const response = error.response?.data;
  const status = error.response?.status;

  if (response?.message) {
    return normalizeServerMessage(response.message, status);
  }

  if (status === 401) {
    return getGenericServerMessage(status);
  }

  if (status === 403) {
    return '没有权限访问该功能，请联系管理员检查角色权限。';
  }

  if (status === 404) {
    return '请求的接口不存在，请确认后端服务和前端版本是否匹配。';
  }

  if (status === 502 || status === 503 || status === 504) {
    return `服务暂时不可用（${status}），请稍后重试。`;
  }

  if (status && status >= 500) {
    return `服务器内部错误（${status}），请稍后重试或联系管理员。`;
  }

  if (error.code === 'ECONNABORTED') {
    return '请求超时，后端服务响应太慢，请稍后重试。';
  }

  if (error.message === 'Network Error' || !error.response) {
    return '无法连接后端 API，请检查服务器是否已启动、域名是否正确或网络是否可用。';
  }

  return normalizeServerMessage(error.message, status);
}

export function isRequestCanceled(error: unknown) {
  if (axios.isCancel(error)) {
    return true;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };

  return (
    candidate.code === 'ERR_CANCELED' ||
    candidate.name === 'AbortError' ||
    candidate.name === 'CanceledError' ||
    candidate.message === 'canceled'
  );
}

function isAuthGateBypassRequest(url: string) {
  return getApiEndpointPolicy(url).bypassSessionGate;
}

function mergeAbortSignals(
  requestSignal: GenericAbortSignal | undefined,
  authSignal: AbortSignal
): AbortSignal {
  if (!requestSignal) {
    return authSignal;
  }

  if (requestSignal.aborted) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  if (authSignal.aborted) {
    return authSignal;
  }

  if (!requestSignal.addEventListener) {
    return authSignal;
  }

  const controller = new AbortController();
  const abort = (event: Event) => {
    const signal = event.target as { reason?: unknown };
    controller.abort(signal.reason);
  };

  requestSignal.addEventListener('abort', abort, { once: true });
  authSignal.addEventListener('abort', abort, { once: true });

  return controller.signal;
}

export async function request<TData>(promise: Promise<{ data: ApiResponse<TData> }>) {
  try {
    const response = await promise;
    const body = response.data;

    if (!body.success) {
      const code = String(body.errorCode ?? '').trim() || 'REQUEST_FAILED';
      throw new ApiError(normalizeServerMessage(body.message), {
        code,
        fieldErrors: body.fieldErrors,
        kind: getApiErrorKind(null, code),
        requestId: body.requestId,
        retryAfterMs: body.retryAfterMs,
        retryable: body.retryable ?? isRetryableApiFailure(null, code),
        status: null
      });
    }

    return body.data;
  } catch (error) {
    if (isRequestCanceled(error)) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<ApiResponse<unknown>>;
      const apiError = createApiError(axiosError);
      const requestUrl = String(axiosError.config?.url ?? '');
      if (axiosError.response?.status === 401 && !isAuthGateBypassRequest(requestUrl)) {
        sessionCoordinator.handleUnauthorized(
          apiError,
          (axiosError.config as RetryableReadRequestConfig | undefined)?.__credentialSnapshot
        );
      } else if (axiosError.response?.status === 403 && !isAuthGateBypassRequest(requestUrl)) {
        sessionCoordinator.handleForbidden(
          apiError,
          (axiosError.config as RetryableReadRequestConfig | undefined)?.__credentialSnapshot
        );
      }
      throw apiError;
    }

    throw error;
  }
}

function createApiError(error: AxiosError<ApiResponse<unknown>>) {
  const body = error.response?.data;
  const errorBody = body && !body.success ? body : null;
  const status = error.response?.status ?? null;
  const code = String(errorBody?.errorCode ?? '').trim() || getFallbackErrorCode(status, error);
  const retryAfterMs =
    errorBody?.retryAfterMs ?? parseRetryAfter(error.response?.headers?.['retry-after']);
  const responseRequestId = String(error.response?.headers?.['x-request-id'] ?? '').trim();
  return new ApiError(getAxiosErrorMessage(error), {
    cause: error,
    code,
    fieldErrors: errorBody?.fieldErrors,
    kind: getApiErrorKind(status, code, error),
    requestId: errorBody?.requestId ?? (responseRequestId || undefined),
    retryAfterMs,
    retryable: errorBody?.retryable ?? isRetryableApiFailure(status, code),
    status
  });
}

function isRetryableApiFailure(status: number | null, code: string) {
  return (
    status === null ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 'AUTH_DEPENDENCY_UNAVAILABLE' ||
    code === 'SERVICE_UNAVAILABLE' ||
    code === 'NETWORK_UNAVAILABLE'
  );
}

function getApiErrorKind(
  status: number | null,
  code: string,
  error?: AxiosError<ApiResponse<unknown>>
): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 400 || status === 422) return 'validation';
  if (status === 409) return 'conflict';
  if (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 'AUTH_DEPENDENCY_UNAVAILABLE' ||
    code === 'SERVICE_UNAVAILABLE'
  ) {
    return 'transient';
  }
  if (!status && error && !error.response) return 'network';
  return 'server';
}

function getFallbackErrorCode(status: number | null, error: AxiosError) {
  if (status === 401) return 'AUTH_INVALID';
  if (status === 403) return 'AUTH_PERMISSION_DENIED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502 || status === 503 || status === 504) return 'SERVICE_UNAVAILABLE';
  if (status && status >= 500) return 'INTERNAL_SERVER_ERROR';
  if (!error.response) return 'NETWORK_UNAVAILABLE';
  return 'REQUEST_FAILED';
}

function parseRetryAfter(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(text).getTime();
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function isWriteMethod(method?: string) {
  return !['get', 'head', 'options'].includes(String(method ?? 'get').toLowerCase());
}

function isRequestCredentialCurrent(snapshot: CredentialSnapshot | null | undefined) {
  const current = sessionCoordinator.getCredentialSnapshot();
  if (!snapshot || !current) return snapshot === current;
  return (
    snapshot.credentialId === current.credentialId &&
    snapshot.tokenRevision === current.tokenRevision
  );
}

function waitForRetry(delayMs: number, signal?: GenericAbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(timer);
        const reason = (signal as GenericAbortSignal & { reason?: unknown }).reason;
        reject(reason ?? new DOMException('请求已取消。', 'AbortError'));
      },
      { once: true }
    );
  });
}
