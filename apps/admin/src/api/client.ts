import type { ApiResponse } from '@apple-business/shared';
import axios, { AxiosError, type GenericAbortSignal, type InternalAxiosRequestConfig } from 'axios';
import {
  AuthSessionExpiredError,
  getAuthSessionAbortSignal,
  isAuthSessionExpired,
  isAuthSessionExpiredError,
  notifyAuthSessionExpired,
  TOKEN_STORAGE_KEY
} from '@/auth/session';
import { getTransientReadRetryDelay } from './transientReadRetry';

export { TOKEN_STORAGE_KEY };

const supabaseFunctionRegion = String(import.meta.env.VITE_SUPABASE_FUNCTION_REGION ?? '').trim();

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 15000
});

export interface ApiRequestOptions {
  signal?: AbortSignal;
}

interface RetryableReadRequestConfig extends InternalAxiosRequestConfig {
  __transientReadRetryCount?: number;
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
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  const requestUrl = String(config.url ?? '');
  const bypassAuthGate = isAuthGateBypassRequest(requestUrl);

  if (isAuthSessionExpired() && !bypassAuthGate) {
    throw new AuthSessionExpiredError();
  }

  if (!bypassAuthGate) {
    config.signal = mergeAbortSignals(config.signal, getAuthSessionAbortSignal());
  }

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  if (supabaseFunctionRegion) {
    config.headers['x-region'] = supabaseFunctionRegion;
  }

  return config;
});

http.interceptors.response.use(undefined, async (error: unknown) => {
  if (!axios.isAxiosError(error)) {
    throw error;
  }

  const config = error.config as RetryableReadRequestConfig | undefined;
  const retryCount = config?.__transientReadRetryCount ?? 0;
  const delayMs = getTransientReadRetryDelay({
    aborted: config?.signal?.aborted,
    method: config?.method,
    retryCount,
    status: error.response?.status,
    url: config?.url
  });

  if (!config || delayMs === null) {
    throw error;
  }

  config.__transientReadRetryCount = retryCount + 1;
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  if (config.signal?.aborted || isAuthSessionExpired()) {
    throw error;
  }

  return http.request(config);
});

export function getApiErrorMessage(error: unknown) {
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
  if (isAuthSessionExpiredError(error)) {
    return true;
  }

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
  return (
    url.includes('/auth/login') ||
    url.includes('/health/ready') ||
    url.includes('/maintenance/mode/public') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  );
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
      throw new Error(normalizeServerMessage(body.message));
    }

    return body.data;
  } catch (error) {
    if (isAuthSessionExpiredError(error)) {
      throw error;
    }

    if (isRequestCanceled(error)) {
      if (isAuthSessionExpired()) {
        throw new AuthSessionExpiredError();
      }

      throw error;
    }

    if (error instanceof AxiosError) {
      const axiosError = error as AxiosError<ApiResponse<unknown>>;
      const message = getAxiosErrorMessage(axiosError);

      const requestUrl = String(axiosError.config?.url ?? '');
      if (axiosError.response?.status === 401 && !isAuthGateBypassRequest(requestUrl)) {
        notifyAuthSessionExpired({
          message,
          reason: 'unauthorized'
        });
        throw new AuthSessionExpiredError(message, {
          cause: error
        });
      }

      throw new Error(message, {
        cause: error
      });
    }

    throw error;
  }
}
