import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SecurityService } from '../security/security.service';
import { V2IdentityService } from '../v2-auth/v2-identity.service';
import { AuthService } from './auth.service';
import { hashPassword } from './password-hasher';
import { SupabaseAuthService } from './supabase-auth.service';

describe('AuthService', () => {
  const now = new Date('2026-06-18T00:00:00.000Z');
  const userId = '33333333-3333-4333-8333-333333333333';
  const authUserId = '44444444-4444-4444-8444-444444444444';
  const authEmail = 'admin@example.invalid';
  const supabaseSessionId = '55555555-5555-4555-8555-555555555555';
  const fixturePassword = 'UnitTestPassword123!';
  const newPassword = 'NewUnitTestPassword456!';
  const supabaseSession = {
    accessToken: 'supabase-access-token',
    refreshToken: 'supabase-refresh-token',
    expiresAt: '2030-01-01T00:00:00.000Z',
    userId,
    sessionId: supabaseSessionId
  };
  const authenticatedUser = {
    id: userId,
    username: 'admin',
    displayName: '管理员',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: false
  };

  async function createService(options?: {
    commitError?: Error;
    mfaRequired?: boolean;
    mfaBound?: boolean;
    supabaseEnabled?: boolean;
    transactionError?: Error;
  }) {
    const passwordHash = await hashPassword(fixturePassword);
    let storedPasswordHash = passwordHash;
    const user = {
      id: userId,
      username: 'admin',
      displayName: '管理员',
      passwordHash,
      status: 'active',
      deletedAt: null
    };
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: 1 }]),
      user: {
        findFirst: jest.fn().mockImplementation(() =>
          Promise.resolve({
            ...user,
            passwordHash: storedPasswordHash
          })
        ),
        update: jest.fn().mockImplementation(({ data }) => {
          if (options?.transactionError) {
            return Promise.reject(options.transactionError);
          }
          storedPasswordHash = data.passwordHash;
          return Promise.resolve({
            ...user,
            passwordHash: storedPasswordHash
          });
        })
      },
      v2AuthIdentity: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      activeSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 })
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-log-1' })
      }
    };
    let transactionCallCount = 0;
    const prismaMock = {
      user: {
        findFirst: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue({ ...user, lastLoginAt: now })
      },
      $transaction: jest.fn(async (callback: (client: typeof transaction) => Promise<unknown>) => {
        transactionCallCount += 1;
        const result = await callback(transaction);
        if (options?.commitError && transactionCallCount === 1) {
          throw options.commitError;
        }
        return result;
      })
    };
    const prisma = prismaMock as unknown as PrismaService;
    const tokenPayload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
    ).toString('base64url');
    const jwtService = {
      sign: jest.fn().mockReturnValue(`header.${tokenPayload}.signature`)
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
      isMfaRequiredForUser: jest.fn().mockResolvedValue(Boolean(options?.mfaRequired)),
      getMfaLoginRequirementForUser: jest.fn().mockResolvedValue({
        required: Boolean(options?.mfaRequired),
        bound: options?.mfaBound ?? Boolean(options?.mfaRequired),
        reason: options?.mfaRequired ? 'bound_user' : null
      }),
      verifyUserMfaCode: jest.fn().mockResolvedValue({ method: 'totp' }),
      recordLoginAttempt: jest.fn().mockResolvedValue({}),
      createActiveSession: jest.fn().mockResolvedValue({}),
      createProviderActiveSession: jest.fn().mockResolvedValue({}),
      revokeAccessToken: jest.fn().mockResolvedValue(true),
      revokeSessionIdentifier: jest.fn().mockResolvedValue(true),
      assertPasswordMeetsPolicy: jest.fn().mockResolvedValue(undefined),
      invalidateActiveSessionCache: jest.fn()
    } as unknown as SecurityService;
    const supabaseAuthService = {
      isEnabled: jest.fn().mockReturnValue(Boolean(options?.supabaseEnabled)),
      authenticateAccessToken: jest.fn().mockResolvedValue({
        userId,
        sessionId: supabaseSessionId,
        expiresAt: new Date(supabaseSession.expiresAt)
      }),
      login: jest.fn().mockResolvedValue(supabaseSession),
      logout: jest.fn().mockResolvedValue(undefined),
      verifyCurrentPassword: jest.fn().mockResolvedValue({
        authEmail,
        authUserId
      }),
      setPasswordWithConfirmation: jest.fn().mockResolvedValue('desired_confirmed'),
      updatePassword: jest.fn().mockResolvedValue(undefined)
    } as unknown as SupabaseAuthService;

    return {
      service: new AuthService(
        prisma,
        jwtService,
        identityService,
        auditLogsService,
        securityService,
        supabaseAuthService
      ),
      prisma,
      jwtService,
      securityService,
      identityService,
      auditLogsService,
      supabaseAuthService,
      transaction
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

  it('still revokes the Supabase session when local revocation fails', async () => {
    const { service, securityService, auditLogsService, supabaseAuthService } = await createService(
      {
        supabaseEnabled: true
      }
    );
    jest
      .mocked(securityService.revokeSessionIdentifier)
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.logout(supabaseSession.accessToken, authenticatedUser)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(supabaseAuthService.logout).toHaveBeenCalledWith(supabaseSession.accessToken);
    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'logout_failed',
        afterData: {
          failedStages: ['local_session']
        }
      })
    );
  });

  it('still revokes the local session when Supabase logout fails', async () => {
    const { service, securityService, supabaseAuthService } = await createService({
      supabaseEnabled: true
    });
    jest
      .mocked(supabaseAuthService.logout)
      .mockRejectedValueOnce(new Error('Supabase unavailable'));

    await expect(
      service.logout(supabaseSession.accessToken, authenticatedUser)
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(securityService.revokeSessionIdentifier).toHaveBeenCalledWith(
      `supabase:${supabaseSessionId}`,
      authenticatedUser
    );
  });

  it('rejects server-side token refresh when Supabase manages the session', async () => {
    const { service, securityService } = await createService({
      supabaseEnabled: true
    });

    await expect(
      service.refresh(authenticatedUser, {
        ip: '127.0.0.1',
        userAgent: 'unit-test'
      })
    ).rejects.toEqual(new BadRequestException('Supabase 登录会话由客户端安全刷新。'));
    expect(securityService.createActiveSession).not.toHaveBeenCalled();
  });

  it('registers a successful Supabase login with its stable session identifier', async () => {
    const { service, securityService, supabaseAuthService } = await createService({
      supabaseEnabled: true
    });

    await expect(
      service.login(
        {
          username: 'admin',
          password: fixturePassword
        },
        {
          ip: '127.0.0.1',
          userAgent: 'unit-test'
        }
      )
    ).resolves.toEqual({
      accessToken: supabaseSession.accessToken,
      refreshToken: supabaseSession.refreshToken,
      expiresAt: supabaseSession.expiresAt,
      user: authenticatedUser
    });

    expect(supabaseAuthService.login).toHaveBeenCalledWith('admin', fixturePassword, undefined);
    expect(securityService.createProviderActiveSession).toHaveBeenCalledWith({
      userId,
      sessionIdentifier: `supabase:${supabaseSessionId}`,
      expiresAt: new Date(supabaseSession.expiresAt),
      ip: '127.0.0.1',
      userAgent: 'unit-test'
    });
  });

  it('logs out the new Supabase session when local session registration fails', async () => {
    const { service, prisma, securityService, supabaseAuthService } = await createService({
      supabaseEnabled: true
    });
    jest
      .mocked(securityService.createProviderActiveSession)
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.login(
        {
          username: 'admin',
          password: fixturePassword
        },
        {
          ip: '127.0.0.1',
          userAgent: 'unit-test'
        }
      )
    ).rejects.toEqual(
      new ServiceUnavailableException('登录会话登记失败，请重新登录。', {
        cause: expect.any(Error)
      })
    );

    expect(supabaseAuthService.logout).toHaveBeenCalledWith(supabaseSession.accessToken);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('changes the password atomically, clears the reset flag, revokes sessions and omits secrets from audit', async () => {
    const { service, securityService, identityService, supabaseAuthService, transaction } =
      await createService({
        supabaseEnabled: true
      });

    await expect(
      service.changePassword(
        {
          currentPassword: fixturePassword,
          newPassword
        },
        supabaseSession.accessToken,
        {
          ...authenticatedUser,
          mustResetPassword: true
        }
      )
    ).resolves.toEqual({
      passwordChanged: true,
      signedOut: true,
      providerSignedOut: true
    });

    expect(supabaseAuthService.setPasswordWithConfirmation).toHaveBeenCalledWith({
      alternatePassword: fixturePassword,
      authEmail,
      authUserId,
      desiredPassword: newPassword
    });
    expect(transaction.v2AuthIdentity.updateMany).toHaveBeenCalledWith({
      where: { userId },
      data: {
        mustResetPassword: false
      }
    });
    expect(transaction.activeSession.updateMany).toHaveBeenCalledWith({
      where: {
        userId,
        revokedAt: null
      },
      data: {
        revokedAt: expect.any(Date)
      }
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId,
        module: 'auth',
        action: 'change_password',
        objectType: 'user',
        objectId: userId,
        afterData: expect.objectContaining({
          mustResetPassword: false,
          revokedSessionCount: 3
        })
      })
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    const serializedAudit = JSON.stringify(
      jest.mocked(transaction.auditLog.create).mock.calls[0]?.[0]
    );
    expect(serializedAudit).not.toContain(fixturePassword);
    expect(serializedAudit).not.toContain(newPassword);
    expect(identityService.invalidateAuthenticatedUser).toHaveBeenCalledWith(userId);
    expect(securityService.invalidateActiveSessionCache).toHaveBeenCalledTimes(1);
    expect(supabaseAuthService.logout).toHaveBeenCalledWith(supabaseSession.accessToken, 'global');
  });

  it('records a provider-wide logout failure after the business sessions are revoked', async () => {
    const { service, auditLogsService, supabaseAuthService } = await createService({
      supabaseEnabled: true
    });
    jest
      .mocked(supabaseAuthService.logout)
      .mockRejectedValueOnce(new Error('provider logout unavailable'));

    await expect(
      service.changePassword(
        {
          currentPassword: fixturePassword,
          newPassword
        },
        supabaseSession.accessToken,
        authenticatedUser
      )
    ).resolves.toEqual({
      passwordChanged: true,
      signedOut: true,
      providerSignedOut: false
    });

    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'change_password_provider_logout_failed',
        afterData: expect.objectContaining({
          businessSessionsRevoked: true
        })
      })
    );
  });

  it('does not update either password store when the current password is wrong', async () => {
    const { service, prisma, supabaseAuthService } = await createService({
      supabaseEnabled: true
    });
    jest
      .mocked(supabaseAuthService.verifyCurrentPassword)
      .mockRejectedValueOnce(new BadRequestException('当前密码不正确，请重新输入。'));

    await expect(
      service.changePassword(
        {
          currentPassword: 'WrongCurrentPassword123!',
          newPassword
        },
        supabaseSession.accessToken,
        authenticatedUser
      )
    ).rejects.toEqual(new BadRequestException('当前密码不正确，请重新输入。'));

    expect(supabaseAuthService.setPasswordWithConfirmation).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not update either password store when the new password violates policy', async () => {
    const { service, prisma, securityService, supabaseAuthService } = await createService({
      supabaseEnabled: true
    });
    jest
      .mocked(securityService.assertPasswordMeetsPolicy)
      .mockRejectedValueOnce(new BadRequestException('密码强度不足。'));

    await expect(
      service.changePassword(
        {
          currentPassword: fixturePassword,
          newPassword: 'weak'
        },
        supabaseSession.accessToken,
        authenticatedUser
      )
    ).rejects.toEqual(new BadRequestException('密码强度不足。'));

    expect(supabaseAuthService.setPasswordWithConfirmation).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('restores the Supabase password when the local password transaction fails', async () => {
    const { service, identityService, securityService, supabaseAuthService } = await createService({
      supabaseEnabled: true,
      transactionError: new Error('transaction failed')
    });

    await expect(
      service.changePassword(
        {
          currentPassword: fixturePassword,
          newPassword
        },
        supabaseSession.accessToken,
        authenticatedUser
      )
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(supabaseAuthService.setPasswordWithConfirmation).toHaveBeenNthCalledWith(1, {
      alternatePassword: fixturePassword,
      authEmail,
      authUserId,
      desiredPassword: newPassword
    });
    expect(supabaseAuthService.setPasswordWithConfirmation).toHaveBeenNthCalledWith(2, {
      alternatePassword: newPassword,
      authEmail,
      authUserId,
      desiredPassword: fixturePassword
    });
    expect(identityService.invalidateAuthenticatedUser).not.toHaveBeenCalled();
    expect(securityService.invalidateActiveSessionCache).not.toHaveBeenCalled();
    expect(supabaseAuthService.logout).not.toHaveBeenCalled();
  });

  it('records a repair event when provider password compensation also fails', async () => {
    const { service, auditLogsService, supabaseAuthService } = await createService({
      supabaseEnabled: true,
      transactionError: new Error('transaction failed')
    });
    jest
      .mocked(supabaseAuthService.setPasswordWithConfirmation)
      .mockResolvedValueOnce('desired_confirmed')
      .mockResolvedValueOnce('unknown');

    await expect(
      service.changePassword(
        {
          currentPassword: fixturePassword,
          newPassword
        },
        supabaseSession.accessToken,
        authenticatedUser
      )
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'change_password_failed',
        afterData: expect.objectContaining({
          providerCompensation: 'failed',
          providerPasswordUpdated: true
        })
      })
    );
  });

  it('reconciles a lost commit response and still closes every session', async () => {
    const { service, supabaseAuthService, auditLogsService, identityService, securityService } =
      await createService({
        supabaseEnabled: true,
        commitError: new Error('commit response lost')
      });

    await expect(
      service.changePassword(
        {
          currentPassword: fixturePassword,
          newPassword
        },
        supabaseSession.accessToken,
        authenticatedUser
      )
    ).resolves.toEqual({
      passwordChanged: true,
      signedOut: true,
      providerSignedOut: true
    });

    expect(supabaseAuthService.setPasswordWithConfirmation).toHaveBeenCalledTimes(1);
    expect(supabaseAuthService.setPasswordWithConfirmation).toHaveBeenCalledWith({
      alternatePassword: fixturePassword,
      authEmail,
      authUserId,
      desiredPassword: newPassword
    });
    expect(auditLogsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'change_password_reconciled',
        afterData: expect.objectContaining({
          localCommitted: true,
          providerPasswordConfirmed: true
        })
      })
    );
    expect(identityService.invalidateAuthenticatedUser).toHaveBeenCalledWith(userId);
    expect(securityService.invalidateActiveSessionCache).toHaveBeenCalled();
    expect(supabaseAuthService.logout).toHaveBeenCalledWith(supabaseSession.accessToken, 'global');
  });

  it('restores the old provider password when an ambiguous write cannot confirm the new password', async () => {
    const { service, supabaseAuthService, transaction } = await createService({
      supabaseEnabled: true
    });
    jest
      .mocked(supabaseAuthService.setPasswordWithConfirmation)
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('desired_confirmed');

    await expect(
      service.changePassword(
        {
          currentPassword: fixturePassword,
          newPassword
        },
        supabaseSession.accessToken,
        authenticatedUser
      )
    ).rejects.toThrow('已恢复原密码');

    expect(transaction.user.update).not.toHaveBeenCalled();
    expect(supabaseAuthService.setPasswordWithConfirmation).toHaveBeenNthCalledWith(2, {
      alternatePassword: newPassword,
      authEmail,
      authUserId,
      desiredPassword: fixturePassword
    });
  });

  it('commits the local password when an ambiguous write later confirms the new provider password', async () => {
    const { service, supabaseAuthService, transaction } = await createService({
      supabaseEnabled: true
    });
    jest
      .mocked(supabaseAuthService.setPasswordWithConfirmation)
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('alternate_confirmed');

    await expect(
      service.changePassword(
        {
          currentPassword: fixturePassword,
          newPassword
        },
        supabaseSession.accessToken,
        authenticatedUser
      )
    ).resolves.toEqual({
      passwordChanged: true,
      providerSignedOut: true,
      signedOut: true
    });

    expect(transaction.user.update).toHaveBeenCalledTimes(1);
  });
});
