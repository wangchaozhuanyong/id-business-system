import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideV2PreloadRecovery, recoverV2PreloadFailure } from './preloadRecovery';

describe('V2 preload recovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

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

  it('reloads module-load failures before the first stable route', () => {
    const reload = vi.fn();
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      location: { reload }
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      })
    });

    expect(
      recoverV2PreloadFailure(
        new TypeError('Failed to fetch dynamically imported module: /src/v2/features/View.vue'),
        {
          buildId: 'build-2',
          hasStableRoute: () => false,
          onRepeatedBootFailure: vi.fn()
        }
      )
    ).toBe('reload-once');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.get('apple-business:v2-preload-reload-build')).toBe('build-2');
  });

  it('shows the degraded route gate after the same build fails again on startup', () => {
    const reload = vi.fn();
    const onRepeatedBootFailure = vi.fn();
    vi.stubGlobal('window', {
      location: { reload }
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => 'build-3'),
      setItem: vi.fn()
    });

    const error = new TypeError('error loading dynamically imported module');
    expect(
      recoverV2PreloadFailure(error, {
        buildId: 'build-3',
        hasStableRoute: () => false,
        onRepeatedBootFailure
      })
    ).toBe('show-degraded');
    expect(reload).not.toHaveBeenCalled();
    expect(onRepeatedBootFailure).toHaveBeenCalledWith(error);
  });

  it('does not turn stable-route module failures into a boot reload', () => {
    const reload = vi.fn();
    const onRepeatedBootFailure = vi.fn();
    vi.stubGlobal('window', {
      location: { reload }
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn()
    });

    expect(
      recoverV2PreloadFailure('Importing a module script failed.', {
        buildId: 'build-2',
        hasStableRoute: () => true,
        onRepeatedBootFailure
      })
    ).toBe('defer-to-router');
    expect(reload).not.toHaveBeenCalled();
    expect(onRepeatedBootFailure).not.toHaveBeenCalled();
  });
});
