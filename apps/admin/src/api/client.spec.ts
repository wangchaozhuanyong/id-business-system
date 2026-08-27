import type { ApiResponse } from '@apple-business/shared';
import type { AxiosAdapter } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStoredCredential, writeStoredCredential } from '@/auth/credential';
import { resetSessionCoordinatorForTests, sessionCoordinator } from '@/auth/sessionCoordinator';
import { ApiError } from './apiError';
import { getApiErrorMessage, http, request } from './client';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('HTTP identity boundary', () => {
  afterEach(() => {
    resetSessionCoordinatorForTests();
    vi.unstubAllGlobals();
  });

  it('rejects a late successful response from an older token revision', async () => {
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    writeStoredCredential(createStoredCredential('token-1', null));
    sessionCoordinator.hydrate();

    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      await responseGate;
      return {
        config,
        data: {
          success: true,
          data: { value: 'stale' },
          message: 'OK',
          requestId: 'request-stale-success',
          timestamp: '2026-08-01T00:00:00.000Z'
        } satisfies ApiResponse<{ value: string }>,
        headers: {},
        status: 200,
        statusText: 'OK'
      };
    });

    const pending = request(
      http.get<ApiResponse<{ value: string }>>('/id-business-v2/test', { adapter })
    );
    await vi.waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));

    sessionCoordinator.updateAccessToken('token-2');
    releaseResponse();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('shows the request id for server failures without changing validation messages', () => {
    const serverError = new ApiError('服务器内部错误（500），请稍后重试。', {
      code: 'INTERNAL_SERVER_ERROR',
      kind: 'server',
      requestId: 'request-server-1234',
      retryable: false,
      status: 500
    });
    const validationError = new ApiError('退回金额必须大于 0。', {
      code: 'BAD_REQUEST',
      kind: 'validation',
      requestId: 'request-validation-1234',
      retryable: false,
      status: 400
    });

    expect(getApiErrorMessage(serverError)).toBe(
      '服务器内部错误（500），请稍后重试。 请求编号：request-server-1234'
    );
    expect(getApiErrorMessage(validationError)).toBe('退回金额必须大于 0。');
  });
});
