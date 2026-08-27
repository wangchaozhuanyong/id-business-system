import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { SecurityService } from '../security/security.service';
import type { V2IdentityService } from '../v2-auth/v2-identity.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password-hasher';

describe('AuthService', () => {
  const userId = '33333333-3333-4333-8333-333333333333';
  const reservationId = '66666666-6666-4666-8666-666666666666';
  const password = 'UnitTestPassword123!';
  const newPassword = 'NewUnitTestPassword456!';
  const authenticatedUser = {
    id: userId,
    username: 'admin',
    displayName: '管理员',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: false
  };

  async function createFixture(options?: {
    mfaRequired?: boolean;
    mfaBound?: boolean;
    transactionError?: Error;
  }) {
    let storedPasswordHash = await hashPassword(password);
    const user = {
      id: userId,
      username: 'admin',
      displayName: '管理员',
      passwordHash: storedPasswordHash,
      status: 'active',
      deletedAt: null
    };
    const transaction = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([{ locked: 1 }]),
      user: {
        findFirst: jest.fn().mockImplementation(() =>
          Promise.resolve({
            ...user,
            passwordHash: storedPasswordHash
          })
        ),
        update: jest.fn().mockImplementation(({ data }) => {
          if (options?.transactionError) return Promise.reject(options.transactionError);
          storedPasswordHash = data.passwordHash;
          return Promise.resolve({ ...user, passwordHash: storedPasswordHash });
        })
      },
      v2AuthIdentity: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      activeSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-log-1' })
      }
    };
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user)
      },
      $transaction: jest.fn((callback) => callback(transaction))
    } as unknown as PrismaService;
    const tokenPayload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    const accessToken = `header.${tokenPayload}.signature`;
    const jwtService = {
      sign: jest.fn().mockReturnValue(accessToken)
    } as unknown as JwtService;
    const identityService = {
      getAuthenticatedUser: jest.fn().mockResolvedValue(authenticatedUser),
      invalidateAuthenticatedUser: jest.fn()
    } as unknown as V2IdentityService;
    const auditLogsService = {
      create: jest.fn().mockResolvedValue({})
    } as unknown as AuditLogsService;
    const securityService = {
      isRequestIpAllowed: jest.fn().mockResolvedValue(true),
      getMfaLoginRequirementForUser: jest.fn().mockResolvedValue({
        required: Boolean(options?.mfaRequired),
        bound: options?.mfaBound ?? Boolean(options?.mfaRequired),
        reason: options?.mfaRequired ? 'bound_user' : null
      }),
      isMfaRequiredForUser: jest.fn().mockResolvedValue(Boolean(options?.mfaRequired)),
      verifyUserMfaCode: jest.fn().mockResolvedValue({ method: 'totp' }),
      recordLoginAttempt: jest.fn().mockResolvedValue({}),
      reserveLoginAttempt: jest.fn().mockResolvedValue({
        allowed: true,
        reservationId
      }),
      finalizeLoginAttempt: jest.fn().mockResolvedValue(true),
      createActiveSession: jest.fn().mockResolvedValue({}),
      revokeAccessToken: jest.fn().mockResolvedValue(true),
      assertPasswordMeetsPolicy: jest.fn().mockResolvedValue(undefined),
      invalidateActiveSessionCache: jest.fn()
    } as unknown as SecurityService;

    return {
      accessToken,
      auditLogsService,
      identityService,
      jwtService,
      prisma,
      securityService,
      service: new AuthService(
        prisma,
        jwtService,
        identityService,
        auditLogsService,
        securityService
      ),
      transaction
    };
  }

  it('logs in with the local password and registers an active session', async () => {
    const fixture = await createFixture();

    await expect(
      fixture.service.login(
        { username: 'admin', password },
        { ip: '127.0.0.1', userAgent: 'unit-test' }
      )
    ).resolves.toEqual({ accessToken: fixture.accessToken, user: authenticatedUser });

    expect(fixture.securityService.createActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: fixture.accessToken,
        userId,
        ip: '127.0.0.1'
      })
    );
    expect(fixture.securityService.finalizeLoginAttempt).toHaveBeenCalledWith(reservationId, {
      userId,
      status: 'success'
    });
  });

  it('rejects an invalid local password before issuing a token', async () => {
    const fixture = await createFixture();

    await expect(
      fixture.service.login({ username: 'admin', password: 'wrong-password' })
    ).rejects.toThrow(new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。'));
    expect(fixture.jwtService.sign).not.toHaveBeenCalled();
    expect(fixture.securityService.createActiveSession).not.toHaveBeenCalled();
  });

  it('requires the bound MFA code before issuing a token', async () => {
    const fixture = await createFixture({ mfaRequired: true });

    await expect(fixture.service.login({ username: 'admin', password })).rejects.toThrow(
      new UnauthorizedException('需要输入动态验证码或恢复码。')
    );
    expect(fixture.jwtService.sign).not.toHaveBeenCalled();
  });

  it('revokes the local access token on logout', async () => {
    const fixture = await createFixture();

    await expect(fixture.service.logout(fixture.accessToken, authenticatedUser)).resolves.toEqual({
      loggedOut: true
    });
    expect(fixture.securityService.revokeAccessToken).toHaveBeenCalledWith(
      fixture.accessToken,
      authenticatedUser
    );
  });

  it('refreshes a local session with a new signed access token', async () => {
    const fixture = await createFixture();

    await expect(fixture.service.refresh(authenticatedUser)).resolves.toEqual({
      accessToken: fixture.accessToken,
      user: authenticatedUser
    });
    expect(fixture.securityService.createActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: fixture.accessToken, userId })
    );
  });

  it('changes the local password and revokes all active sessions atomically', async () => {
    const fixture = await createFixture();

    await expect(
      fixture.service.changePassword(
        { currentPassword: password, newPassword },
        fixture.accessToken,
        authenticatedUser
      )
    ).resolves.toEqual({ passwordChanged: true, signedOut: true });

    expect(fixture.transaction.user.update).toHaveBeenCalledTimes(1);
    expect(fixture.transaction.activeSession.updateMany).toHaveBeenCalledWith({
      where: { userId, revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });
    expect(fixture.identityService.invalidateAuthenticatedUser).toHaveBeenCalledWith(userId);
    expect(fixture.securityService.invalidateActiveSessionCache).toHaveBeenCalledTimes(1);
  });

  it('rejects an incorrect current password without changing stored data', async () => {
    const fixture = await createFixture();

    await expect(
      fixture.service.changePassword(
        { currentPassword: 'wrong-password', newPassword },
        fixture.accessToken,
        authenticatedUser
      )
    ).rejects.toThrow(new BadRequestException('当前密码不正确，请重新输入。'));
    expect(fixture.transaction.user.update).not.toHaveBeenCalled();
  });
});
