import { describe, expect, it } from 'vitest';
import {
  getApiEndpointPolicy,
  getApiRequestPolicy,
  getApiRequestRetryDelay
} from './requestPolicy';

describe('API request policy registry', () => {
  it('gives auth/me a bounded timeout and two jittered transient retries', () => {
    expect(getApiRequestPolicy('GET', '/auth/me')?.timeoutMs).toBe(8_000);
    const input = {
      isNetworkError: false,
      method: 'GET',
      random: () => 0.5,
      retryCount: 0,
      status: 503,
      url: '/auth/me'
    };
    expect(getApiRequestRetryDelay(input)).toBe(200);
    expect(getApiRequestRetryDelay({ ...input, retryCount: 1 })).toBe(800);
    expect(getApiRequestRetryDelay({ ...input, retryCount: 2 })).toBeNull();
  });

  it('retries registered reads for network, 502, 503 and 504 only', () => {
    const input = {
      isNetworkError: false,
      method: 'GET',
      random: () => 0.5,
      retryCount: 0,
      status: 502,
      url: '/id-business-v2/accounts'
    };
    expect(getApiRequestRetryDelay(input)).toBe(200);
    expect(getApiRequestRetryDelay({ ...input, status: 504 })).toBe(200);
    expect(getApiRequestRetryDelay({ ...input, status: 500 })).toBeNull();
    expect(getApiRequestRetryDelay({ ...input, status: undefined, isNetworkError: true })).toBe(
      200
    );
  });

  it('does not retry writes, unrelated APIs or canceled requests', () => {
    const input = {
      isNetworkError: false,
      method: 'GET',
      random: () => 0.5,
      retryCount: 0,
      status: 503,
      url: '/id-business-v2/accounts'
    };
    expect(getApiRequestRetryDelay({ ...input, method: 'POST' })).toBeNull();
    expect(getApiRequestRetryDelay({ ...input, url: '/health/ready' })).toBeNull();
    expect(getApiRequestRetryDelay({ ...input, aborted: true })).toBeNull();
  });

  it('declares auth lifecycle exceptions by exact endpoint policy', () => {
    expect(getApiEndpointPolicy('/auth/logout').key).toBe('auth-logout');
    expect(getApiEndpointPolicy('/auth/change-password').bypassSessionGate).toBe(true);
    expect(getApiEndpointPolicy('/id-business-v2/branding/public').key).toBe('public-branding');
    expect(getApiEndpointPolicy('/id-business-v2/branding/public').bypassSessionGate).toBe(true);
    expect(getApiEndpointPolicy('/public/mailbox/query').key).toBe('public-mailbox');
    expect(getApiEndpointPolicy('/public/mailbox/query').bypassSessionGate).toBe(true);
    expect(getApiEndpointPolicy('/id-business-v2/branding').bypassSessionGate).toBe(false);
    expect(getApiEndpointPolicy('/id-business-v2/auth/logout').bypassSessionGate).toBe(false);
  });
});
