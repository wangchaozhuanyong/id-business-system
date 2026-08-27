import { HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpException } from '../errors/api-http.exception';
import { HttpExceptionFilter } from './http-exception.filter';

function createHost() {
  const headers = new Map<string, string>();
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = {
    setHeader: (name: string, value: string) => headers.set(name, value),
    status
  };
  const request = {
    headers: { 'x-request-id': 'request-test-1234', 'cf-ray': 'ray-test' },
    method: 'GET',
    originalUrl: '/api/auth/me?ignored=true'
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response
    })
  } as unknown as ArgumentsHost;
  return { headers, host, json, status };
}

describe('HttpExceptionFilter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps stable error metadata and request correlation in the compatible envelope', () => {
    const fixture = createHost();
    const filter = new HttpExceptionFilter();
    filter.catch(
      new ApiHttpException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'AUTH_DEPENDENCY_UNAVAILABLE',
        '登录服务暂时不可用，请稍后重试。',
        { retryAfterMs: 1_200 }
      ),
      fixture.host
    );

    expect(fixture.status).toHaveBeenCalledWith(503);
    expect(fixture.headers.get('X-Request-Id')).toBe('request-test-1234');
    expect(fixture.headers.get('Retry-After')).toBe('2');
    expect(fixture.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'AUTH_DEPENDENCY_UNAVAILABLE',
        requestId: 'request-test-1234',
        retryable: true,
        retryAfterMs: 1_200
      })
    );
  });

  it('does not expose raw unknown exception details', () => {
    const fixture = createHost();
    new HttpExceptionFilter().catch(new Error('database password=secret'), fixture.host);
    const body = fixture.json.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误，请稍后重试。',
      retryable: false
    });
    expect(body).not.toHaveProperty('details');
  });

  it('logs sanitized provider codes in Supabase even when Cloudflare forwards the request', () => {
    vi.stubEnv('SUPABASE_EDGE_FUNCTION', 'true');
    vi.stubEnv('CLOUDFLARE_WORKER', 'false');
    const fixture = createHost();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exception = Object.assign(new Error('database password=secret'), {
      code: 'P2010',
      meta: { code: '42883', message: 'database password=secret' }
    });

    new HttpExceptionFilter().catch(exception, fixture.host);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toMatchObject({
      cfRay: 'ray-test',
      databaseErrorCode: '42883',
      errorCode: 'INTERNAL_SERVER_ERROR',
      providerErrorCode: 'P2010',
      requestId: 'request-test-1234',
      status: 500,
      type: 'api_error'
    });
    expect(logged).not.toContain('password=secret');
  });
});
