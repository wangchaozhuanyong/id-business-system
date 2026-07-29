import { describe, expect, it } from 'vitest';
import { decideV2PreloadRecovery } from './preloadRecovery';

describe('V2 preload recovery', () => {
  it('defers stable-route failures to the real navigation or speculative caller', () => {
    expect(
      decideV2PreloadRecovery({
        buildId: 'build-2',
        hasStableRoute: true,
        lastReloadedBuildId: null
      })
    ).toBe('defer-to-router');
  });

  it('reloads an initial chunk failure only once for the same deployment', () => {
    expect(
      decideV2PreloadRecovery({
        buildId: 'build-2',
        hasStableRoute: false,
        lastReloadedBuildId: null
      })
    ).toBe('reload-once');
    expect(
      decideV2PreloadRecovery({
        buildId: 'build-2',
        hasStableRoute: false,
        lastReloadedBuildId: 'build-2'
      })
    ).toBe('show-degraded');
  });
});
