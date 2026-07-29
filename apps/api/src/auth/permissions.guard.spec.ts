import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY } from './auth.decorators';
import { PermissionsGuard } from './permissions.guard';

function createGuard(requiredPermissions: string[]) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return false;
      if (key === PERMISSIONS_KEY) return requiredPermissions;
      return undefined;
    })
  } as unknown as Reflector;

  return new PermissionsGuard(reflector);
}

function createContext(user: { roles: string[]; permissions: string[] }) {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({
        user
      })
    })
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  it('allows a user with every required permission', () => {
    const guard = createGuard(['id.order.create', 'id.order.view']);
    const context = createContext({
      roles: [],
      permissions: ['id.order.create', 'id.order.view']
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows the admin role without duplicating every permission', () => {
    const guard = createGuard(['id.option.manage']);
    const context = createContext({
      roles: ['admin'],
      permissions: []
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a user missing one of the required permissions', () => {
    const guard = createGuard(['id.order.create', 'id.order.view']);
    const context = createContext({
      roles: [],
      permissions: ['id.order.view']
    });

    expect(() => guard.canActivate(context)).toThrow(new ForbiddenException('Permission denied'));
  });

  it('requires exact permission names', () => {
    const guard = createGuard(['id.order.create']);
    const context = createContext({
      roles: [],
      permissions: ['id.order.view']
    });

    expect(() => guard.canActivate(context)).toThrow(new ForbiddenException('Permission denied'));
  });
});
