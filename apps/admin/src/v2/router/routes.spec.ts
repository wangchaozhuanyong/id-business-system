import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markV2RoutePrefetch } from '@/runtime/performance';
import { hasUserFeatureAccess } from '@/utils/permissions';
import { v2ModuleDefinitions } from '@/v2/config/modules';
import type { CurrentUser } from '@/types/system';
import {
  v2Routes,
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
  it('limits the actual audit navigation and recovery routes to administrators', () => {
    const employee: CurrentUser = {
      id: 'user-1',
      username: 'employee',
      displayName: '员工',
      mustResetPassword: false,
      roles: ['employee'],
      permissions: ['audit_log.view']
    };
    const admin: CurrentUser = { ...employee, roles: ['admin'], permissions: [] };
    for (const key of ['audit-logs', 'data-governance', 'auto-registration']) {
      const feature = v2ModuleDefinitions.find((module) => module.key === key)!;
      expect(hasUserFeatureAccess(employee, feature)).toBe(false);
      expect(hasUserFeatureAccess(admin, feature)).toBe(true);
    }
  });
  it('redirects legacy resource URLs and preserves query and hash', () => {
    const children = v2Routes[0]!.children!;
    for (const [old, target] of [
      ['auto-recharge/proxies', 'proxies'],
      ['online-recharge/proxies', 'proxies'],
      ['auto-recharge/mailbox', 'mailbox'],
      ['auto-recharge/chatgpt-accounts', 'chatgpt-accounts'],
      ['auto-recharge/bank-cards', 'bank-cards'],
      ['online-recharge/cards', 'bank-cards'],
      ['auto-recharge/bank-orders', 'bank-orders']
    ]) {
      const redirect = children.find((route) => route.path === old)?.redirect;
      expect(typeof redirect).toBe('function');
      expect(
        (redirect as (to: unknown) => unknown)({ query: { page: '2' }, hash: '#detail' })
      ).toEqual({ path: `/v2/account-settings/${target}`, query: { page: '2' }, hash: '#detail' });
    }
  });
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
