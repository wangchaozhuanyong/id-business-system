import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SecurityService } from '../security/security.service';
import { V2IdentityService } from '../v2-auth/v2-identity.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password-hasher';

describe('AuthService', () => {
  const now = new Date('2026-06-18T00:00:00.000Z');
  const userId = '33333333-3333-4333-8333-333333333333';
  const fixturePassword = 'UnitTestPassword123!';
  const authenticatedUser = {
    id: userId,
    username: 'admin',
    displayName: '管理员',
    roles: ['admin'],
    permissions: []
  };

  async function createService(options?: { mfaRequired?: boolean; mfaBound?: boolean }) {
    const passwordHash = await hashPassword(fixturePassword);
    const user = {
      id: userId,
      username: 'admin',
      displayName: '管理员',
      passwordHash,
      status: 'active',
      deletedAt: null
    };
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue({ ...user, lastLoginAt: now })
      }
    } as unknown as PrismaService;
    const tokenPayload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    const jwtService = {
      sign: jest.fn().mockReturnValue(`header.${tokenPayload}.signature`)
    } as unknown as JwtService;
    const identityService = {
      getAuthenticatedUser: jest.fn().mockResolvedValue(authenticatedUser)
    } as unknown as V2IdentityService;
    const auditLogsService = {
      create: jest.fn().mockResolvedValue({})
    } as unknown as AuditLogsService;
    const securityService = {
      isRequestIpAllowed: jest.fn().mockResolvedValue(true),
      isMfaRequiredForUser: jest.fn().mockResolvedValue(Boolean(options?.mfaRequired)),
      getMfaLoginRequirementForUser: jest.fn().mockResolvedValue({
        required: Boolean(options?.mfaRequired),
        bound: options?.mfaBound ?? Boolean(options?.mfaRequired),
        reason: options?.mfaRequired ? 'bound_user' : null
      }),
      verifyUserMfaCode: jest.fn().mockResolvedValue({ method: 'totp' }),
      recordLoginAttempt: jest.fn().mockResolvedValue({}),
      createActiveSession: jest.fn().mockResolvedValue({}),
      revokeAccessToken: jest.fn().mockResolvedValue(true)
    } as unknown as SecurityService;

    return {
      service: new AuthService(
        prisma,
        jwtService,
        identityService,
        auditLogsService,
        securityService
      ),
      prisma,
      jwtService,
      securityService
    };
  }

  it('blocks token issuance when bound MFA code is missing', async () => {
    const { service, prisma, jwtService, securityService } = await createService({
      mfaRequired: true
    });

    await expect(
      service.login(
        {
          username: 'admin',
          password: fixturePassword
        },
        { ip: '127.0.0.1', userAgent: 'unit-test' }
      )
    ).rejects.toThrow(new UnauthorizedException('需要输入动态验证码或恢复码。'));

    expect(securityService.recordLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'admin',
        userId,
        status: 'blocked',
        failureReason: 'mfa_required'
      })
    );
    expect(securityService.verifyUserMfaCode).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('blocks administrator login when MFA is mandatory but not bound', async () => {
    const { service, prisma, jwtService, securityService } = await createService({
      mfaRequired: true,
      mfaBound: false
    });

    await expect(
      service.login(
        {
          username: 'admin',
          password: fixturePassword,
          mfaCode: '123456'
        },
        { ip: '127.0.0.1', userAgent: 'unit-test' }
      )
    ).rejects.toThrow(
      new UnauthorizedException('管理员账号必须先绑定 MFA 后才能登录，请联系已登录管理员处理。')
    );

    expect(securityService.recordLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'admin',
        userId,
        status: 'blocked',
        failureReason: 'mfa_not_bound'
      })
    );
    expect(securityService.verifyUserMfaCode).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('blocks token issuance when request IP is not whitelisted', async () => {
    const { service, prisma, jwtService, securityService } = await createService();
    (securityService.isRequestIpAllowed as jest.Mock).mockResolvedValueOnce(false);

    await expect(
      service.login(
        {
          username: 'admin',
          password: fixturePassword
        },
        { ip: '10.0.1.25', userAgent: 'unit-test' }
      )
    ).rejects.toThrow(new UnauthorizedException('当前 IP 不在白名单内，无法登录。'));

    expect(securityService.recordLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'admin',
        status: 'blocked',
        failureReason: 'ip_not_allowed'
      })
    );
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('blocks token issuance when bound MFA code is invalid', async () => {
    const { service, jwtService, securityService } = await createService({
      mfaRequired: true
    });
    (securityService.verifyUserMfaCode as jest.Mock).mockRejectedValueOnce(
      new Error('invalid mfa')
    );

    await expect(
      service.login(
        {
          username: 'admin',
          password: fixturePassword,
          mfaCode: '000000'
        },
        { ip: '127.0.0.1', userAgent: 'unit-test' }
      )
    ).rejects.toThrow(new UnauthorizedException('动态验证码或恢复码错误，请重新输入。'));

    expect(securityService.recordLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'blocked',
        failureReason: 'mfa_invalid'
      })
    );
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it('verifies bound MFA code before issuing login token', async () => {
    const { service, jwtService, securityService } = await createService({
      mfaRequired: true
    });

    const result = await service.login(
      {
        username: 'admin',
        password: fixturePassword,
        mfaCode: '123456'
      },
      { ip: '127.0.0.1', userAgent: 'unit-test' }
    );

    expect(securityService.verifyUserMfaCode).toHaveBeenCalledWith(userId, '123456');
    expect(jwtService.sign).toHaveBeenCalledWith({
      sub: userId,
      username: 'admin',
      jti: expect.any(String)
    });
    expect(securityService.recordLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'admin',
        status: 'success'
      })
    );
    expect(securityService.createActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        accessToken: result.accessToken
      })
    );
  });

  it('creates an active session when refreshing a token', async () => {
    const { service, securityService } = await createService();

    const result = await service.refresh(authenticatedUser, {
      ip: '127.0.0.1',
      userAgent: 'unit-test'
    });

    expect(securityService.createActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        accessToken: result.accessToken,
        ip: '127.0.0.1',
        userAgent: 'unit-test'
      })
    );
  });

  it('revokes the active session when logging out', async () => {
    const { service, securityService } = await createService();

    await expect(service.logout('plain.jwt.token', authenticatedUser)).resolves.toEqual({
      loggedOut: true
    });
    expect(securityService.revokeAccessToken).toHaveBeenCalledWith(
      'plain.jwt.token',
      authenticatedUser
    );
  });
});
