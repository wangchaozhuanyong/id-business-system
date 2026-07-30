import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetV2RouteNavigationState,
  setV2RouteNavigationState,
  v2RouteNavigationState
} from './routes';

describe('V2 route navigation state', () => {
  beforeEach(() => {
    resetV2RouteNavigationState();
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
