export class IdBusinessV2RelayRemoteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'IdBusinessV2RelayRemoteError';
  }
}

function safeMessage(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{32,}/gi, '[已隐藏]')
    .slice(0, 360);
}

export async function idBusinessV2RelayFetchJson<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers
      },
      redirect: 'error',
      signal: options.signal ?? controller.signal
    });
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 2_000_000) {
      throw new IdBusinessV2RelayRemoteError('远程接口返回内容过大', 'REMOTE_RESPONSE_TOO_LARGE');
    }
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const record =
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      const nested =
        record.error && typeof record.error === 'object'
          ? (record.error as Record<string, unknown>).message
          : undefined;
      throw new IdBusinessV2RelayRemoteError(
        safeMessage(nested ?? record.message, `远程接口返回 HTTP ${response.status}`),
        'REMOTE_HTTP_ERROR',
        response.status
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof IdBusinessV2RelayRemoteError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new IdBusinessV2RelayRemoteError('远程接口请求超时', 'REMOTE_TIMEOUT');
    }
    throw new IdBusinessV2RelayRemoteError('暂时无法连接远程接口', 'REMOTE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

export function unwrapIdBusinessV2RelayEnvelope<T>(payload: unknown): T {
  if (!payload || typeof payload !== 'object') return payload as T;
  const record = payload as Record<string, unknown>;
  if (!Object.hasOwn(record, 'code')) return payload as T;
  if (record.code !== 0) {
    throw new IdBusinessV2RelayRemoteError(
      safeMessage(record.message, '中转站接口返回失败'),
      `CLOUDBRIDGE_${String(record.code)}`
    );
  }
  return record.data as T;
}
