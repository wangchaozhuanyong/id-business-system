import { HttpStatus, Logger, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
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
    baseUrl: '/api/v2/finance',
    headers: { 'x-request-id': 'request-test-1234', 'cf-ray': 'ray-test' },
    method: 'GET',
    originalUrl: '/api/auth/me?ignored=true',
    route: { path: '/inflows' }
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
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const exception = Object.assign(new Error('database password=secret'), { code: 'P2010' });
    new HttpExceptionFilter().catch(exception, fixture.host);
    const body = fixture.json.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      errorCode: 'INTERNAL_SERVER_ERROR',
      message: '服务器内部错误，请稍后重试。',
      retryable: false
    });
    expect(body).not.toHaveProperty('details');
    expect(logger).toHaveBeenCalledWith({
      event: 'http_request_failed',
      requestId: 'request-test-1234',
      method: 'GET',
      route: '/api/v2/finance/inflows',
      status: 500,
      exceptionName: 'Error',
      exceptionCode: 'P2010'
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain('password=secret');
    logger.mockRestore();
  });
});
