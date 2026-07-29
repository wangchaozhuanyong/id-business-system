import { describe, expect, it } from 'vitest';
import { getTransientReadRetryDelay } from './transientReadRetry';

describe('getTransientReadRetryDelay', () => {
  it('retries V2 GET requests twice with bounded backoff', () => {
    const input = {
      method: 'GET',
      retryCount: 0,
      status: 503,
      url: '/id-business-v2/options/selectors'
    };

    expect(getTransientReadRetryDelay(input)).toBe(180);
    expect(getTransientReadRetryDelay({ ...input, retryCount: 1 })).toBe(650);
    expect(getTransientReadRetryDelay({ ...input, retryCount: 2 })).toBeNull();
  });

  it('does not retry writes, unrelated APIs, other errors or canceled requests', () => {
    const input = {
      method: 'GET',
      retryCount: 0,
      status: 503,
      url: '/id-business-v2/accounts'
    };

    expect(getTransientReadRetryDelay({ ...input, method: 'POST' })).toBeNull();
    expect(getTransientReadRetryDelay({ ...input, url: '/auth/me' })).toBeNull();
    expect(getTransientReadRetryDelay({ ...input, status: 500 })).toBeNull();
    expect(getTransientReadRetryDelay({ ...input, aborted: true })).toBeNull();
  });
});
