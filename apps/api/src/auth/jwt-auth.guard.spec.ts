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
import { BROWSER_SESSION_COOKIE_NAME } from './browser-session-cookie';
import {
  createRegistrationWorkspaceSession,
  REGISTRATION_WORKSPACE_PATH
} from './registration-workspace-session';

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
    method: 'GET',
    headers: {
      authorization: 'Bearer local-access-token',
      cookie: `${BROWSER_SESSION_COOKIE_NAME}=cookie-access-token`,
      origin: 'http://localhost:5374',
      'sec-fetch-site': 'same-origin',
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
  it('validates an opaque workspace session through all existing authentication checks', async () => {
    const fixture = createFixture({ mfaRequired: true, tokenMfaVerified: true });
    attachWorkspaceSession(fixture);
    await expect(fixture.guard.canActivate(fixture.context)).resolves.toBe(true);
    expect(fixture.jwtService.verifyAsync).toHaveBeenCalledWith('workspace-access-token');
    expect(fixture.securityService.isAccessTokenActive).toHaveBeenCalledWith(
      'workspace-access-token'
    );
    expect(fixture.securityService.isRequestIpAllowed).toHaveBeenCalledWith('127.0.0.1', [
      'admin',
      'api'
    ]);
    expect(fixture.identityService.getAuthenticatedUser).toHaveBeenCalledWith(fixture.user.id);
    expect(fixture.securityService.isMfaRequiredForUser).toHaveBeenCalledWith(fixture.user);
  });

  it('keeps a Bearer session ahead of the workspace cookie', async () => {
    const fixture = createFixture();
    attachWorkspaceSession(fixture);
    fixture.request.headers.authorization = 'Bearer local-access-token';
    await expect(fixture.guard.canActivate(fixture.context)).resolves.toBe(true);
    expect(fixture.jwtService.verifyAsync).toHaveBeenCalledWith('local-access-token');
  });

  it('rejects a workspace handle whose authenticated user differs from the JWT subject', async () => {
    const fixture = createFixture();
    attachWorkspaceSession(fixture, 'another-user-id');
    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_INVALID');
    expect(fixture.securityService.isAccessTokenActive).not.toHaveBeenCalled();
    expect(fixture.identityService.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('rejects a revoked workspace session', async () => {
    const fixture = createFixture();
    attachWorkspaceSession(fixture);
    jest.mocked(fixture.securityService.isAccessTokenActive).mockResolvedValueOnce(false);
    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_REVOKED');
  });

  it('rejects workspace sessions without the required MFA evidence', async () => {
    const fixture = createFixture({ mfaRequired: true });
    attachWorkspaceSession(fixture);
    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_MFA_REQUIRED');
  });

  it('rejects workspace sessions on blocked request IPs', async () => {
    const fixture = createFixture();
    attachWorkspaceSession(fixture);
    jest.mocked(fixture.securityService.isRequestIpAllowed).mockResolvedValueOnce(false);
    await expectApiError(fixture.guard.canActivate(fixture.context), 403, 'AUTH_IP_BLOCKED');
  });

  it('validates the cookie through all existing checks only on the restore read', async () => {
    const fixture = createFixture({ mfaRequired: true, tokenMfaVerified: true });
    fixture.request.headers.authorization = '';
    fixture.request.originalUrl = '/api/auth/session';
    await expect(fixture.guard.canActivate(fixture.context)).resolves.toBe(true);
    expect(fixture.jwtService.verifyAsync).toHaveBeenCalledWith('cookie-access-token');
    expect(fixture.securityService.isAccessTokenActive).toHaveBeenCalledWith('cookie-access-token');
    expect(fixture.securityService.isRequestIpAllowed).toHaveBeenCalled();
    expect(fixture.identityService.getAuthenticatedUser).toHaveBeenCalled();
  });

  it.each([
    ['POST', '/api/auth/session', 'same-origin'],
    ['GET', '/api/auth/me', 'same-origin'],
    ['POST', '/api/id-business-v2/orders', 'same-origin'],
    ['GET', '/api/auth/session/other', 'same-origin'],
    ['GET', '/api/auth/session', 'cross-site'],
    ['GET', '/api/auth/session', 'same-site'],
    ['GET', '/api/auth/session', 'none'],
    ['GET', '/api/auth/session', '']
  ])('does not authorize cookie-only %s %s from %s', async (method, url, site) => {
    const fixture = createFixture();
    fixture.request.headers.authorization = '';
    fixture.request.method = method;
    fixture.request.originalUrl = url;
    fixture.request.headers['sec-fetch-site'] = site;
    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_MISSING');
    expect(fixture.jwtService.verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects revoked cookie sessions', async () => {
    const fixture = createFixture();
    fixture.request.headers.authorization = '';
    fixture.request.originalUrl = '/api/auth/session';
    jest.mocked(fixture.securityService.isAccessTokenActive).mockResolvedValueOnce(false);
    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_REVOKED');
  });

  it('rejects expired cookie tokens before consulting active sessions', async () => {
    const fixture = createFixture();
    fixture.request.headers.authorization = '';
    fixture.request.originalUrl = '/api/auth/session';
    jest
      .mocked(fixture.jwtService.verifyAsync)
      .mockRejectedValueOnce(Object.assign(new Error('expired'), { name: 'TokenExpiredError' }));
    await expectApiError(fixture.guard.canActivate(fixture.context), 401, 'AUTH_EXPIRED');
    expect(fixture.securityService.isAccessTokenActive).not.toHaveBeenCalled();
  });
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

function attachWorkspaceSession(
  fixture: ReturnType<typeof createFixture>,
  userId = fixture.user.id
) {
  const response = { setHeader: jest.fn() };
  createRegistrationWorkspaceSession(response, 'workspace-access-token', userId, fixture.request);
  fixture.request.headers.authorization = '';
  fixture.request.headers.cookie = String(response.setHeader.mock.calls[0]?.[1]).split(';')[0]!;
  fixture.request.originalUrl = `${REGISTRATION_WORKSPACE_PATH}/api/tasks`;
}

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
