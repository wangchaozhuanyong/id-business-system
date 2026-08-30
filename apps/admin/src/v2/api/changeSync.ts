import type { V2ChangeVersionsResult } from '@apple-business/shared';
import { ApiError } from '@/api/apiError';
import { http, request } from '@/api/client';
import { sessionCoordinator } from '@/auth/sessionCoordinator';

const MAX_EVENT_BUFFER_CHARS = 64 * 1024;

export type V2ChangeStreamEventType = 'change' | 'heartbeat' | 'snapshot';

export interface V2ChangeStreamOptions {
  signal: AbortSignal;
  onActivity: () => void;
  onEvent: (type: V2ChangeStreamEventType, payload: unknown) => void;
  onOpen: () => void;
}

interface ParsedSseEvent {
  data: unknown;
  type: V2ChangeStreamEventType;
}

export const idBusinessV2ChangeSyncApi = {
  getVersions(options: { signal?: AbortSignal } = {}) {
    return request<V2ChangeVersionsResult>(
      http.get('/id-business-v2/change-versions', {
        signal: options.signal
      })
    );
  },

  async streamEvents(options: V2ChangeStreamOptions) {
    const credential = sessionCoordinator.getCredentialSnapshot();
    if (!credential?.token) {
      throw new ApiError('请先登录后再连接实时数据。', {
        code: 'AUTH_MISSING',
        kind: 'unauthorized',
        retryable: false,
        status: 401
      });
    }

    const response = await fetch(resolveApiUrl('/realtime/events'), {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${credential.token}`,
        'Cache-Control': 'no-cache'
      },
      cache: 'no-store',
      signal: options.signal
    });

    if (!response.ok) {
      const authRejected = response.status === 401 || response.status === 403;
      const error = new ApiError(
        response.status === 401
          ? '登录状态已过期，请重新登录。'
          : response.status === 403
            ? '没有权限连接实时数据，请联系管理员检查账号状态。'
            : `实时数据连接失败（${response.status}）。`,
        {
          code:
            response.status === 401
              ? 'AUTH_INVALID'
              : response.status === 403
                ? 'AUTH_PERMISSION_DENIED'
                : 'REALTIME_CONNECTION_FAILED',
          kind:
            response.status === 401
              ? 'unauthorized'
              : response.status === 403
                ? 'forbidden'
                : 'transient',
          retryable: !authRejected,
          status: response.status
        }
      );
      if (response.status === 401) {
        sessionCoordinator.handleUnauthorized(error, credential);
      } else if (response.status === 403) {
        sessionCoordinator.handleForbidden(error, credential);
      }
      throw error;
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      throw new ApiError('实时数据连接返回了无效响应。', {
        code: 'REALTIME_INVALID_RESPONSE',
        kind: 'transient',
        retryable: true,
        status: response.status
      });
    }

    options.onOpen();
    await consumeV2ChangeEventStream(response.body, options);
  }
};

export async function consumeV2ChangeEventStream(
  stream: ReadableStream<Uint8Array>,
  options: Pick<V2ChangeStreamOptions, 'onActivity' | 'onEvent'>
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      buffer = dispatchCompleteEvents(buffer, options);
      if (buffer.length > MAX_EVENT_BUFFER_CHARS) {
        throw new Error('实时数据事件超过允许大小。');
      }
      if (result.done) break;
    }
    if (buffer.trim()) dispatchParsedEvent(parseSseEvent(buffer), options);
  } finally {
    reader.releaseLock();
  }
}

export function parseSseEvent(block: string): ParsedSseEvent | null {
  let type = 'message';
  const dataLines: string[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separatorIndex = rawLine.indexOf(':');
    const field = separatorIndex < 0 ? rawLine : rawLine.slice(0, separatorIndex);
    const rawValue = separatorIndex < 0 ? '' : rawLine.slice(separatorIndex + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') type = value;
    if (field === 'data') dataLines.push(value);
  }

  if (!isV2ChangeStreamEventType(type) || !dataLines.length) return null;
  try {
    return {
      type,
      data: JSON.parse(dataLines.join('\n')) as unknown
    };
  } catch {
    return null;
  }
}

function dispatchCompleteEvents(
  value: string,
  options: Pick<V2ChangeStreamOptions, 'onActivity' | 'onEvent'>
) {
  let buffer = value;
  while (true) {
    const separator = buffer.match(/\r?\n\r?\n/);
    if (!separator || separator.index === undefined) return buffer;
    const block = buffer.slice(0, separator.index);
    buffer = buffer.slice(separator.index + separator[0].length);
    dispatchParsedEvent(parseSseEvent(block), options);
  }
}

function dispatchParsedEvent(
  event: ParsedSseEvent | null,
  options: Pick<V2ChangeStreamOptions, 'onActivity' | 'onEvent'>
) {
  if (!event) return;
  options.onActivity();
  options.onEvent(event.type, event.data);
}

function isV2ChangeStreamEventType(value: string): value is V2ChangeStreamEventType {
  return value === 'change' || value === 'heartbeat' || value === 'snapshot';
}

function resolveApiUrl(path: string) {
  const baseUrl = String(http.defaults.baseURL ?? '/api').replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const value = `${baseUrl}${normalizedPath}`;
  return new URL(value, window.location.origin).toString();
}
