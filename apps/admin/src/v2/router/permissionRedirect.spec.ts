import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '@/types/system';
import { getFirstAllowedV2Route } from '@/v2/router/permissionRedirect';

function createUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'user-1',
    username: 'operator',
    displayName: '操作员',
    roles: [],
    permissions: [],
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

  it('redirects a user without any V2 permission to the forbidden page', () => {
    expect(getFirstAllowedV2Route(createUser())).toBe('/403');
  });
});
