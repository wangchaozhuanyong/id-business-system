import type { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ApiResponseInterceptor } from './api-response.interceptor';

function createContext() {
  const request = {
    headers: { 'x-request-id': 'request-test-1234' }
  };
  const response = { setHeader: vi.fn() };
  return {
    getClass: () => ApiResponseInterceptor,
    getHandler: () => ApiResponseInterceptor.prototype.intercept,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response
    })
  } as unknown as ExecutionContext;
}

async function intercept<T>(data: T) {
  return lastValueFrom(
    new ApiResponseInterceptor<T>().intercept(createContext(), { handle: () => of(data) })
  );
}

describe('ApiResponseInterceptor', () => {
  it.each([
    { success: true, message: 'iCloud 邮箱连接正常' },
    { success: false, message: '无效的查询码', items: [] }
  ])('将含 success 的业务结果放入统一 data 响应', async (result) => {
    await expect(intercept(result)).resolves.toMatchObject({
      success: true,
      data: result,
      message: 'ok',
      requestId: 'request-test-1234'
    });
  });

  it('保留已完整封装的成功响应', async () => {
    const response = {
      success: true as const,
      data: { status: 'ok' },
      message: 'ok',
      requestId: 'request-existing-1234',
      timestamp: '2026-09-15T00:00:00.000Z'
    };

    await expect(intercept(response)).resolves.toBe(response);
  });

  it('保留已完整封装的错误响应', async () => {
    const response = {
      success: false as const,
      errorCode: 'SERVICE_UNAVAILABLE',
      message: '服务暂时不可用',
      requestId: 'request-existing-5678',
      retryable: true,
      timestamp: '2026-09-15T00:00:00.000Z'
    };

    await expect(intercept(response)).resolves.toBe(response);
  });
});
