import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/apiError';
import { shouldIgnoreRuntimeError } from './appRuntimeError';

describe('V2 app runtime error classification', () => {
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

  it('keeps real application errors fatal', () => {
    expect(shouldIgnoreRuntimeError(new Error('Cannot read properties of undefined'))).toBe(false);
  });
});
