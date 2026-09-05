import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthAvailabilityMonitor } from '../../auth/auth-availability.monitor';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { ApiResponseInterceptor } from '../../common/interceptors/api-response.interceptor';
import { IdBusinessV2ManagedMailboxController } from './id-business-v2-managed-mailbox.controller';
import { IdBusinessV2MicrosoftMailboxOAuthController } from './id-business-v2-microsoft-mailbox-oauth.controller';

function createContext(controller: object, handler: object, roles?: string[]) {
  const request = {
    headers: {},
    user: roles ? { roles, permissions: [] } : undefined
  };
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader: vi.fn() })
    })
  } as unknown as ExecutionContext;
}

const callbackContext = () =>
  createContext(
    IdBusinessV2MicrosoftMailboxOAuthController,
    IdBusinessV2MicrosoftMailboxOAuthController.prototype.callback
  );

describe('Microsoft mailbox OAuth callback HTTP boundary', () => {
  const reflector = new Reflector();
  const jwtGuard = new JwtAuthGuard(
    reflector,
    {} as never,
    {} as never,
    {} as never,
    new AuthAvailabilityMonitor()
  );
  const permissionsGuard = new PermissionsGuard(reflector);

  it('accepts the provider redirect without an application bearer token', async () => {
    await expect(jwtGuard.canActivate(callbackContext())).resolves.toBe(true);
    expect(permissionsGuard.canActivate(callbackContext())).toBe(true);
  });

  it.each(['list', 'startMicrosoftAuthorization', 'getMicrosoftAuthorizationStatus'] as const)(
    'keeps %s restricted to authenticated administrators',
    async (method) => {
      const handler = IdBusinessV2ManagedMailboxController.prototype[method];
      await expect(
        jwtGuard.canActivate(createContext(IdBusinessV2ManagedMailboxController, handler))
      ).rejects.toMatchObject({ status: 401 });
      expect(() =>
        permissionsGuard.canActivate(
          createContext(IdBusinessV2ManagedMailboxController, handler, ['employee'])
        )
      ).toThrow('当前角色没有权限访问该功能。');
    }
  );

  it.each([true, false])('returns raw HTML for authorization result %s', async (succeeded) => {
    const authorization = { complete: vi.fn().mockResolvedValue({ succeeded }) };
    const controller = new IdBusinessV2MicrosoftMailboxOAuthController(authorization as never);
    const query = { code: 'test-authorization-code', state: 'test-authorization-state' };
    const html = await controller.callback(query);
    const response = await lastValueFrom(
      new ApiResponseInterceptor<string>().intercept(callbackContext(), { handle: () => of(html) })
    );

    expect(authorization.complete).toHaveBeenCalledWith(query);
    expect(typeof response).toBe('string');
    expect(response).toBe(html);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain(succeeded ? 'Microsoft 邮箱授权完成' : 'Microsoft 邮箱授权失败');
    expect(html).not.toContain(query.code);
    expect(html).not.toContain(query.state);
  });

  it('renders a safe failure page when state validation rejects the callback', async () => {
    const authorization = {
      complete: vi.fn().mockRejectedValue(new Error('invalid-test-state'))
    };
    const controller = new IdBusinessV2MicrosoftMailboxOAuthController(authorization as never);

    const html = await controller.callback({});

    expect(html).toContain('Microsoft 邮箱授权失败');
    expect(html).not.toContain('invalid-test-state');
    expect(authorization.complete).toHaveBeenCalledWith({});
  });
});
