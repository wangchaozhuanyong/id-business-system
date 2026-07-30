import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '@/types/system';
import { hasUserFeatureAccess } from '@/utils/permissions';
import { employeesFeature } from '@/v2/features/employees/manifest';
import { getFirstAllowedV2Route } from '@/v2/router/permissionRedirect';

function createUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'user-1',
    username: 'operator',
    displayName: '操作员',
    roles: [],
    permissions: [],
    mustResetPassword: false,
    ...overrides
  };
}

describe('V2 permission redirect', () => {
  it('redirects an administrator to the first V2 workspace', () => {
    expect(getFirstAllowedV2Route(createUser({ roles: ['admin'] }))).toBe('/v2/workbench/renewals');
  });

  it('redirects a user to the first allowed module', () => {
    expect(getFirstAllowedV2Route(createUser({ permissions: ['apple.order.create'] }))).toBe(
      '/v2/workbench/order-entry'
    );
  });

  it('redirects an authenticated user without business permissions to the shared dashboard', () => {
    expect(getFirstAllowedV2Route(createUser())).toBe('/v2/dashboard');
  });

  it('keeps administrator-only planned pages hidden from non-admin users', () => {
    expect(hasUserFeatureAccess(createUser(), employeesFeature)).toBe(false);
    expect(hasUserFeatureAccess(createUser({ roles: ['admin'] }), employeesFeature)).toBe(true);
  });
});
