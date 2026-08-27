import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markV2RoutePrefetch } from '@/runtime/performance';
import {
  prefetchV2Route,
  resetV2RouteNavigationState,
  setV2RouteNavigationState,
  v2RouteNavigationState
} from './routes';

vi.mock('@/runtime/performance', () => ({
  markV2RoutePrefetch: vi.fn()
}));
vi.mock('@/v2/layouts/V2AdminLayout.vue', () => ({ default: {} }));
vi.mock('@/v2/features/options/V2OptionsView.vue', () => ({ default: {} }));

describe('V2 route navigation state', () => {
  beforeEach(() => {
    vi.mocked(markV2RoutePrefetch).mockClear();
    resetV2RouteNavigationState();
  });

  it('marks route prefetch ready only after the route modules finish loading', async () => {
    const loading = prefetchV2Route('/v2/options');

    expect(markV2RoutePrefetch).toHaveBeenCalledWith('/v2/options', 'hover', 'start');
    expect(markV2RoutePrefetch).not.toHaveBeenCalledWith('/v2/options', 'hover', 'ready');

    await loading;

    expect(markV2RoutePrefetch).toHaveBeenCalledWith('/v2/options', 'hover', 'ready');
  });

  it('clears pending and stable workspace state when navigation leaves V2', () => {
    setV2RouteNavigationState('/v2/options', 'ready');
    setV2RouteNavigationState('/v2/records/topups', 'pending');

    resetV2RouteNavigationState('/login?redirect=/v2/records/topups');

    expect(v2RouteNavigationState).toMatchObject({
      path: '/login?redirect=/v2/records/topups',
      stablePath: '',
      state: 'idle',
      error: null
    });
  });

  it('clears a first-route error before rendering a public page', () => {
    setV2RouteNavigationState('/v2/options', 'error', new Error('chunk failed'));

    resetV2RouteNavigationState('/login');

    expect(v2RouteNavigationState).toMatchObject({
      path: '/login',
      stablePath: '',
      state: 'idle',
      error: null
    });
  });
});
