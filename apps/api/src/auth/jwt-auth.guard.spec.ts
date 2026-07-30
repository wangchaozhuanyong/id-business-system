import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { SecurityService } from '../security/security.service';
import type { V2IdentityService } from '../v2-auth/v2-identity.service';
import { ALLOW_DURING_PASSWORD_RESET_KEY, IS_PUBLIC_KEY } from './auth.decorators';
import type { AuthenticatedUser } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { SupabaseAuthService } from './supabase-auth.service';

interface GuardFixtureOptions {
  allowDuringPasswordReset?: boolean;
  user?: AuthenticatedUser;
}

function createFixture(options: GuardFixtureOptions = {}) {
  const expiresAt = new Date('2026-07-30T12:00:00.000Z');
  const user: AuthenticatedUser = options.user ?? {
    id: '33333333-3333-4333-8333-333333333333',
    username: 'admin',
    displayName: '管理员',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: false
  };
  const request: {
    headers: {
      authorization: string;
      'user-agent': string;
    };
    ip: string;
    originalUrl: string;
    user?: AuthenticatedUser;
  } = {
    headers: {
      authorization: 'Bearer supabase-access-token',
      'user-agent': 'jwt-auth-guard-unit-test'
    },
    ip: '127.0.0.1',
    originalUrl: '/api/id-business-v2/orders'
  };
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return false;
      if (key === ALLOW_DURING_PASSWORD_RESET_KEY) {
        return options.allowDuringPasswordReset;
      }
      return undefined;
    })
  } as unknown as Reflector;
  const jwtService = {
    verifyAsync: jest.fn()
  } as unknown as JwtService;
  const identityService = {
    getAuthenticatedUser: jest.fn().mockResolvedValue(user)
  } as unknown as V2IdentityService;
  const securityService = {
    isRequestIpAllowed: jest.fn().mockResolvedValue(true),
    ensureActiveSession: jest.fn().mockResolvedValue(true)
  } as unknown as SecurityService;
  const supabaseAuthService = {
    isEnabled: jest.fn().mockReturnValue(true),
    authenticateAccessToken: jest.fn().mockResolvedValue({
      userId: user.id,
      sessionId: '44444444-4444-4444-8444-444444444444',
      expiresAt
    })
  } as unknown as SupabaseAuthService;
  const context = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => request
    })
  } as unknown as ExecutionContext;

  return {
    context,
    expiresAt,
    guard: new JwtAuthGuard(
      reflector,
      jwtService,
      identityService,
      securityService,
      supabaseAuthService
    ),
    identityService,
    request,
    securityService,
    supabaseAuthService,
    user
  };
}

describe('JwtAuthGuard', () => {
  it('tracks a verified Supabase access token by its stable session_id', async () => {
    const fixture = createFixture();

    await expect(fixture.guard.canActivate(fixture.context)).resolves.toBe(true);

    expect(fixture.securityService.ensureActiveSession).toHaveBeenCalledWith({
      userId: fixture.user.id,
      sessionIdentifier: 'supabase:44444444-4444-4444-8444-444444444444',
      expiresAt: fixture.expiresAt,
      ip: '127.0.0.1',
      userAgent: 'jwt-auth-guard-unit-test'
    });
    expect(fixture.request.user).toEqual(fixture.user);
  });

  it('rejects a password-reset-required user from ordinary business endpoints', async () => {
    const fixture = createFixture({
      user: {
        id: '33333333-3333-4333-8333-333333333333',
        username: 'employee',
        displayName: '待改密员工',
        roles: ['employee'],
        permissions: [],
        mustResetPassword: true
      }
    });

    await expect(fixture.guard.canActivate(fixture.context)).rejects.toEqual(
      new ForbiddenException('必须先修改临时密码后才能访问业务功能。')
    );
  });

  it('allows a password-reset-required user on an explicitly allowed endpoint', async () => {
    const fixture = createFixture({
      allowDuringPasswordReset: true,
      user: {
        id: '33333333-3333-4333-8333-333333333333',
        username: 'employee',
        displayName: '待改密员工',
        roles: ['employee'],
        permissions: [],
        mustResetPassword: true
      }
    });

    await expect(fixture.guard.canActivate(fixture.context)).resolves.toBe(true);
    expect(fixture.request.user).toEqual(fixture.user);
  });

  it('fails closed when SecurityService rejects a revoked session', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.securityService.ensureActiveSession)
      .mockRejectedValueOnce(new UnauthorizedException('会话已被撤销。'));

    await expect(fixture.guard.canActivate(fixture.context)).rejects.toEqual(
      new UnauthorizedException('会话已被撤销。')
    );
    expect(fixture.identityService.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('fails closed when SecurityService cannot find a registered session', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.securityService.ensureActiveSession)
      .mockRejectedValueOnce(new Error('session_not_registered'));

    await expect(fixture.guard.canActivate(fixture.context)).rejects.toEqual(
      new UnauthorizedException('登录状态无效或已过期，请重新登录。')
    );
    expect(fixture.identityService.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('fails closed when SecurityService reports an inactive session', async () => {
    const fixture = createFixture();
    jest.mocked(fixture.securityService.ensureActiveSession).mockResolvedValueOnce(false);

    await expect(fixture.guard.canActivate(fixture.context)).rejects.toEqual(
      new UnauthorizedException('登录状态已过期或已被下线，请重新登录。')
    );
    expect(fixture.identityService.getAuthenticatedUser).not.toHaveBeenCalled();
  });
});
