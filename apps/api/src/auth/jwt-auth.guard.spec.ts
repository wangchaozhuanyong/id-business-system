import { HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { SecurityService } from '../security/security.service';
import type { V2IdentityService } from '../v2-auth/v2-identity.service';
import { ALLOW_DURING_PASSWORD_RESET_KEY, IS_PUBLIC_KEY } from './auth.decorators';
import type { AuthenticatedUser } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { SupabaseAuthService } from './supabase-auth.service';
import { ApiHttpException, authHttpError } from '../common/errors/api-http.exception';
import { AuthAvailabilityMonitor } from './auth-availability.monitor';

interface GuardFixtureOptions {
  allowDuringPasswordReset?: boolean;
  mfaRequired?: boolean;
  providerMfaVerified?: boolean;
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
    ensureActiveSession: jest.fn().mockResolvedValue(true),
    getMfaLoginRequirementForUser: jest.fn().mockResolvedValue({
      required: Boolean(options.mfaRequired),
      bound: Boolean(options.mfaRequired),
      reason: options.mfaRequired ? 'bound_user' : null
    }),
    isMfaRequiredForUser: jest.fn().mockResolvedValue(Boolean(options.mfaRequired))
  } as unknown as SecurityService;
  const supabaseAuthService = {
    isEnabled: jest.fn().mockReturnValue(true),
    authenticateAccessToken: jest.fn().mockResolvedValue({
      userId: user.id,
      sessionId: '44444444-4444-4444-8444-444444444444',
      expiresAt,
      mfaVerified: Boolean(options.providerMfaVerified)
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
      supabaseAuthService,
      new AuthAvailabilityMonitor()
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

  it('requires an MFA-proven active session after the user MFA policy becomes active', async () => {
    const fixture = createFixture({ mfaRequired: true, providerMfaVerified: true });

    await expect(fixture.guard.canActivate(fixture.context)).resolves.toBe(true);

    expect(fixture.securityService.ensureActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIdentifier: 'supabase:mfa:44444444-4444-4444-8444-444444444444'
      })
    );
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

    await expectApiError(
      fixture.guard.canActivate(fixture.context),
      403,
      'AUTH_PASSWORD_RESET_REQUIRED'
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
      .mockRejectedValueOnce(
        authHttpError(
          HttpStatus.UNAUTHORIZED,
          'AUTH_REVOKED',
          '登录状态已过期或已被下线，请重新登录。'
        )
      );

    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_REVOKED');
    expect(fixture.request.user).toBeUndefined();
  });

  it('classifies an unexpected active-session dependency failure as retryable 503', async () => {
    const fixture = createFixture();
    jest
      .mocked(fixture.securityService.ensureActiveSession)
      .mockRejectedValueOnce(new Error('session_not_registered'));

    await expectApiError(
      fixture.guard.canActivate(fixture.context),
      503,
      'AUTH_DEPENDENCY_UNAVAILABLE'
    );
    expect(fixture.request.user).toBeUndefined();
  });

  it('fails closed when SecurityService reports an inactive session', async () => {
    const fixture = createFixture();
    jest.mocked(fixture.securityService.ensureActiveSession).mockResolvedValue(false);

    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_REVOKED');
    expect(fixture.request.user).toBeUndefined();
  });

  it('loads session, user and MFA checks concurrently while preserving the session result', async () => {
    const fixture = createFixture();
    let resolveActiveSession: ((active: boolean) => void) | undefined;
    jest.mocked(fixture.securityService.ensureActiveSession).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveActiveSession = resolve;
        })
    );

    const activation = fixture.guard.canActivate(fixture.context);
    await expect
      .poll(() => jest.mocked(fixture.identityService.getAuthenticatedUser).mock.calls.length)
      .toBe(1);

    expect(fixture.identityService.getAuthenticatedUser).toHaveBeenCalledWith(fixture.user.id);
    expect(fixture.securityService.getMfaLoginRequirementForUser).toHaveBeenCalledWith(
      fixture.user
    );
    expect(resolveActiveSession).toBeTypeOf('function');

    resolveActiveSession?.(true);
    await expect(activation).resolves.toBe(true);
  });
});

async function expectApiError(promise: Promise<unknown>, status: number, errorCode: string) {
  try {
    await promise;
    throw new Error('Expected authentication to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiHttpException);
    expect((error as ApiHttpException).getStatus()).toBe(status);
    expect((error as ApiHttpException).getResponse()).toMatchObject({ errorCode });
  }
}
