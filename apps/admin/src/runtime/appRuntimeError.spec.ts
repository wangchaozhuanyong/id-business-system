import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanceledError } from 'axios';
import { ApiError } from '@/api/apiError';
import {
  appRuntimeError,
  captureAppRuntimeError,
  classifyAppRuntimeError,
  clearAppRuntimeError,
  resolveWindowRuntimeErrorReason,
  shouldIgnoreRuntimeError
} from './appRuntimeError';

describe('V2 app runtime error classification', () => {
  afterEach(() => {
    clearAppRuntimeError();
  });

  it('ignores typed API failures that belong to the request/session boundary', () => {
    expect(
      shouldIgnoreRuntimeError(
        new ApiError('登录服务暂时不可用', {
          code: 'AUTH_DEPENDENCY_UNAVAILABLE',
          kind: 'transient',
          retryable: true,
          status: 503
        })
      )
    ).toBe(true);
  });

  it('does not classify route failures from message text', () => {
    expect(
      shouldIgnoreRuntimeError(
        new Error('Failed to fetch dynamically imported module: /assets/V2OrdersView.js')
      )
    ).toBe(false);
    expect(
      shouldIgnoreRuntimeError(new Error(`Couldn't resolve component "default" at "/v2/orders"`))
    ).toBe(false);
  });

  it('ignores browser and Axios cancellation shapes', () => {
    expect(shouldIgnoreRuntimeError(new DOMException('请求已取消。', 'AbortError'))).toBe(true);
    expect(shouldIgnoreRuntimeError(new CanceledError('canceled'))).toBe(true);
    expect(shouldIgnoreRuntimeError({ code: 'ERR_CANCELED' })).toBe(true);
    expect(shouldIgnoreRuntimeError({ __CANCEL__: true })).toBe(true);
    expect(shouldIgnoreRuntimeError({ message: 'canceled' })).toBe(true);
    expect(classifyAppRuntimeError({ name: 'CanceledError' })).toEqual({
      action: 'ignore',
      category: 'cancellation'
    });
  });

  it('ignores empty browser resource events but preserves real window errors', () => {
    const emptyReason = resolveWindowRuntimeErrorReason({ type: 'error' });
    expect(emptyReason).toBeNull();
    expect(classifyAppRuntimeError(emptyReason, 'window')).toEqual({
      action: 'ignore',
      category: 'browser-event'
    });
    expect(classifyAppRuntimeError({}, 'promise')).toEqual({
      action: 'overlay',
      category: 'application'
    });

    const error = new TypeError('Cannot read properties of undefined');
    expect(resolveWindowRuntimeErrorReason({ error, message: 'Script error.' })).toBe(error);
    expect(resolveWindowRuntimeErrorReason({ message: 'Script error.' })).toMatchObject({
      message: 'Script error.'
    });
  });

  it('keeps real application errors fatal', () => {
    expect(shouldIgnoreRuntimeError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(classifyAppRuntimeError(new TypeError('Cannot read properties of undefined'))).toEqual({
      action: 'overlay',
      category: 'application'
    });
  });

  it('captures only real incidents with safe route and build diagnostics', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      captureAppRuntimeError(
        'promise',
        { code: 'ERR_CANCELED' },
        {
          route: '/v2/dashboard?token=secret',
          buildId: 'build-1'
        }
      )
    ).toBe(false);
    expect(appRuntimeError.value).toBeNull();

    expect(
      captureAppRuntimeError('vue', new TypeError('Cannot read properties of undefined'), {
        route: '/v2/dashboard?token=secret#private',
        buildId: 'build-1'
      })
    ).toBe(true);
    expect(appRuntimeError.value).toMatchObject({
      category: 'application',
      source: 'vue',
      route: '/v2/dashboard',
      buildId: 'build-1'
    });
    expect(appRuntimeError.value?.referenceId).toMatch(/^RT-V-[A-Z0-9]+-[A-Z0-9]{2}$/);
  });
});
