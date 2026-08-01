import { describe, expect, it, vi } from 'vitest';
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import { createSessionRecoveryTracker, createVerifiedDegradedFallback } from './sessionRecovery';

describe('session route recovery', () => {
  it('refreshes once when the same identity recovers through refreshing', () => {
    const recovered = vi.fn();
    const track = createSessionRecoveryTracker(recovered);

    track('ready');
    track('degraded');
    track('refreshing');
    track('ready');
    track('ready');

    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('cancels stale recovery after the session becomes anonymous', () => {
    const recovered = vi.fn();
    const track = createSessionRecoveryTracker(recovered);

    track('degraded');
    track('anonymous');
    track('ready');

    expect(recovered).not.toHaveBeenCalled();
  });

  it('creates an explicit redirect back to from for verified degraded navigation', () => {
    const from = {
      path: '/v2/accounts',
      fullPath: '/v2/accounts?page=2#list',
      query: { page: '2' },
      hash: '#list'
    } as unknown as RouteLocationNormalizedLoaded;

    expect(createVerifiedDegradedFallback(from)).toEqual({
      path: '/v2/accounts',
      query: { page: '2' },
      hash: '#list',
      replace: true
    });
  });
});
