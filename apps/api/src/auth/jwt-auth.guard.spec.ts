import { HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { SecurityService } from '../security/security.service';
import type { V2IdentityService } from '../v2-auth/v2-identity.service';
import { ApiHttpException } from '../common/errors/api-http.exception';
import { ALLOW_DURING_PASSWORD_RESET_KEY, IS_PUBLIC_KEY } from './auth.decorators';
import { AuthAvailabilityMonitor } from './auth-availability.monitor';
import type { AuthenticatedUser } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';

interface FixtureOptions {
  allowDuringPasswordReset?: boolean;
  mfaRequired?: boolean;
  tokenMfaVerified?: boolean;
  user?: AuthenticatedUser;
}

function createFixture(options: FixtureOptions = {}) {
  const user: AuthenticatedUser = options.user ?? {
    id: '33333333-3333-4333-8333-333333333333',
    username: 'admin',
    displayName: '管理员',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: false
  };
  const request = {
    headers: {
      authorization: 'Bearer local-access-token',
      'user-agent': 'jwt-auth-guard-unit-test'
    },
    ip: '127.0.0.1',
    originalUrl: '/api/id-business-v2/orders',
    user: undefined as AuthenticatedUser | undefined
  };
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return false;
      if (key === ALLOW_DURING_PASSWORD_RESET_KEY) return options.allowDuringPasswordReset;
      return undefined;
    })
  } as unknown as Reflector;
  const jwtService = {
    verifyAsync: jest.fn().mockResolvedValue({
      sub: user.id,
      username: user.username,
      jti: 'token-id',
      mfaVerified: Boolean(options.tokenMfaVerified)
    })
  } as unknown as JwtService;
  const identityService = {
    getAuthenticatedUser: jest.fn().mockResolvedValue(user)
  } as unknown as V2IdentityService;
  const securityService = {
    isAccessTokenActive: jest.fn().mockResolvedValue(true),
    isRequestIpAllowed: jest.fn().mockResolvedValue(true),
    isMfaRequiredForUser: jest.fn().mockResolvedValue(Boolean(options.mfaRequired))
  } as unknown as SecurityService;
  const context = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext;

  return {
    context,
    guard: new JwtAuthGuard(
      reflector,
      jwtService,
      identityService,
      securityService,
      new AuthAvailabilityMonitor()
    ),
    identityService,
    jwtService,
    request,
    securityService,
    user
  };
}

describe('JwtAuthGuard', () => {
  it('verifies a local JWT, active session and request IP', async () => {
    const fixture = createFixture();

    await expect(fixture.guard.canActivate(fixture.context)).resolves.toBe(true);

    expect(fixture.jwtService.verifyAsync).toHaveBeenCalledWith('local-access-token');
    expect(fixture.securityService.isAccessTokenActive).toHaveBeenCalledWith('local-access-token');
    expect(fixture.securityService.isRequestIpAllowed).toHaveBeenCalledWith('127.0.0.1', [
      'admin',
      'api'
    ]);
    expect(fixture.request.user).toEqual(fixture.user);
  });

  it('rejects an inactive local session', async () => {
    const fixture = createFixture();
    jest.mocked(fixture.securityService.isAccessTokenActive).mockResolvedValueOnce(false);

    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_REVOKED');
    expect(fixture.request.user).toBeUndefined();
  });

  it('requires MFA evidence in the local JWT when the user policy requires MFA', async () => {
    const fixture = createFixture({ mfaRequired: true, tokenMfaVerified: false });

    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_MFA_REQUIRED');
  });

  it('allows a locally verified MFA session', async () => {
    const fixture = createFixture({ mfaRequired: true, tokenMfaVerified: true });

    await expect(fixture.guard.canActivate(fixture.context)).resolves.toBe(true);
  });

  it('blocks ordinary access until a temporary password is changed', async () => {
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
      HttpStatus.FORBIDDEN,
      'AUTH_PASSWORD_RESET_REQUIRED'
    );
  });

  it('allows password-reset endpoints for a temporary-password user', async () => {
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
  });
});

async function expectApiError(promise: Promise<unknown>, status: number, errorCode: string) {
  try {
    await promise;
    throw new Error('expected promise to reject');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiHttpException);
    expect((error as ApiHttpException).getStatus()).toBe(status);
    expect((error as ApiHttpException).getResponse()).toEqual(
      expect.objectContaining({ errorCode })
    );
  }
}
