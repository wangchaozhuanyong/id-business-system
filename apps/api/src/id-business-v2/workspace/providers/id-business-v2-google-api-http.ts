export class IdBusinessV2GoogleApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'IdBusinessV2GoogleApiError';
  }
}

function safeGoogleMessage(value: unknown, fallback: string) {
  if (typeof value !== 'string') return fallback;
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:Bearer\s+)?[A-Za-z0-9._-]{32,}/gi, '[已隐藏]')
    .slice(0, 360);
}

export async function idBusinessV2GoogleApiFetchJson<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
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
      throw new IdBusinessV2GoogleApiError('Google 接口返回内容过大', 'GOOGLE_RESPONSE_TOO_LARGE');
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
      throw new IdBusinessV2GoogleApiError(
        safeGoogleMessage(
          nested ?? record.error_description,
          `Google 接口返回 HTTP ${response.status}`
        ),
        response.status === 401 ? 'GOOGLE_AUTH_EXPIRED' : 'GOOGLE_HTTP_ERROR',
        response.status
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof IdBusinessV2GoogleApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new IdBusinessV2GoogleApiError('连接 Google 接口超时', 'GOOGLE_TIMEOUT');
    }
    throw new IdBusinessV2GoogleApiError('暂时无法连接 Google 接口', 'GOOGLE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}
