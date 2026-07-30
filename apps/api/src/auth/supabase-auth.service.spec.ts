import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../common/prisma/prisma.service';
import { hashPassword } from './password-hasher';
import { SupabaseAuthService } from './supabase-auth.service';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn()
}));

describe('SupabaseAuthService', () => {
  const userId = '33333333-3333-4333-8333-333333333333';
  const authUserId = '44444444-4444-4444-8444-444444444444';
  const providerSessionId = '55555555-5555-4555-8555-555555555555';
  const password = 'ExistingAdminPassword123!';
  const authEmail = 'admin-3333333333334333@v2-auth.invalid';
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: authUserId,
        session_id: providerSessionId,
        exp: expiresAtSeconds
      })
    ).toString('base64url'),
    'signature'
  ].join('.');
  const session = {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_in: 3600,
    expires_at: expiresAtSeconds,
    token_type: 'bearer',
    user: {
      id: authUserId
    }
  };

  async function createService(options?: {
    mustResetPassword?: boolean;
    storedPassword?: string;
    initialSignInSucceeds?: boolean;
    claimsValid?: boolean;
    claimsExpiresAt?: number;
    factorListFails?: boolean;
    loginAuthUserId?: string;
    lastAuthenticatedAt?: Date | null;
    loginSessionIdMissing?: boolean;
    mfaVerificationFails?: boolean;
    verifiedFactorType?: 'phone' | 'totp' | 'webauthn';
    verifiedFactor?: boolean;
    claimsAal?: 'aal1' | 'aal2';
  }) {
    const passwordHash = await hashPassword(options?.storedPassword ?? password);
    const identity = {
      authEmail,
      authUserId,
      userId,
      mustResetPassword: options?.mustResetPassword ?? true,
      lastAuthenticatedAt: options?.lastAuthenticatedAt ?? null,
      user: {
        passwordHash
      }
    };
    const prisma = {
      v2AuthIdentity: {
        findFirst: vi.fn().mockResolvedValue(identity),
        update: vi.fn().mockResolvedValue(identity)
      }
    } as unknown as PrismaService;
    const config = {
      get: vi.fn((key: string) => {
        const values: Record<string, string> = {
          AUTH_PROVIDER: 'supabase',
          SUPABASE_URL: 'https://project.supabase.co',
          SUPABASE_ANON_KEY: 'anon-key',
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
        };
        return values[key];
      })
    } as unknown as ConfigService;
    const loginSessionBase = {
      ...session,
      user: {
        id: options?.loginAuthUserId ?? authUserId
      }
    };
    const loginSession = options?.loginSessionIdMissing
      ? {
          ...loginSessionBase,
          access_token: [
            Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
            Buffer.from(
              JSON.stringify({
                sub: authUserId,
                exp: expiresAtSeconds
              })
            ).toString('base64url'),
            'signature'
          ].join('.')
        }
      : loginSessionBase;
    const verifiedFactorType = options?.verifiedFactorType ?? 'totp';
    const verifiedFactors = options?.verifiedFactor
      ? [
          {
            factor_type: verifiedFactorType,
            id: 'verified-factor',
            status: 'verified'
          }
        ]
      : [];
    const publicClient = {
      auth: {
        getClaims: vi.fn().mockResolvedValue(
          options?.claimsValid === false
            ? {
                data: null,
                error: {
                  message: 'invalid access token'
                }
              }
            : {
                data: {
                  claims: {
                    sub: authUserId,
                    session_id: options?.loginSessionIdMissing ? undefined : providerSessionId,
                    exp: options?.claimsExpiresAt ?? expiresAtSeconds,
                    aal: options?.claimsAal ?? (options?.verifiedFactor ? 'aal2' : 'aal1')
                  }
                },
                error: null
              }
        ),
        signInWithPassword: vi
          .fn()
          .mockResolvedValueOnce(
            options?.initialSignInSucceeds
              ? { data: { session: loginSession }, error: null }
              : { data: { session: null }, error: { message: 'invalid credentials' } }
          )
          .mockResolvedValue({ data: { session: loginSession }, error: null }),
        mfa: {
          listFactors: vi.fn().mockResolvedValue(
            options?.factorListFails
              ? {
                  data: null,
                  error: {
                    message: 'MFA service unavailable'
                  }
                }
              : {
                  data: {
                    all: verifiedFactors,
                    phone: verifiedFactors.filter((factor) => factor.factor_type === 'phone'),
                    totp: verifiedFactors.filter((factor) => factor.factor_type === 'totp'),
                    webauthn: verifiedFactors.filter((factor) => factor.factor_type === 'webauthn')
                  },
                  error: null
                }
          ),
          challengeAndVerify: vi.fn().mockResolvedValue(
            options?.mfaVerificationFails
              ? {
                  data: null,
                  error: {
                    message: 'invalid MFA code'
                  }
                }
              : {
                  data: loginSession,
                  error: null
                }
          )
        }
      }
    };
    const serviceClient = {
      auth: {
        admin: {
          updateUserById: vi.fn().mockResolvedValue({
            data: {
              user: session.user
            },
            error: null
          }),
          signOut: vi.fn().mockResolvedValue({
            data: {},
            error: null
          })
        }
      }
    };

    vi.mocked(createClient).mockImplementation((_url, key) => {
      return (key === 'service-role-key' ? serviceClient : publicClient) as never;
    });

    return {
      service: new SupabaseAuthService(config, prisma),
      prisma,
      publicClient,
      serviceClient,
      loginSession
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrates the stored password once and then signs in through Supabase Auth', async () => {
    const { service, prisma, publicClient, serviceClient } = await createService({
      verifiedFactor: true
    });

    await expect(service.login('admin', password, '000000')).resolves.toEqual({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
      userId,
      sessionId: providerSessionId
    });

    expect(serviceClient.auth.admin.updateUserById).toHaveBeenCalledWith(authUserId, {
      password
    });
    expect(publicClient.auth.signInWithPassword).toHaveBeenCalledTimes(2);
    expect(prisma.v2AuthIdentity.update).toHaveBeenCalledWith({
      where: {
        userId
      },
      data: {
        lastAuthenticatedAt: expect.any(Date)
      }
    });
  });

  it('returns the verified token claim expiry without recomputing it from the clock', async () => {
    const claimsExpiresAt = expiresAtSeconds - 120;
    const { service } = await createService({
      initialSignInSucceeds: true,
      verifiedFactor: true,
      claimsExpiresAt
    });

    await expect(service.login('admin', password, '000000')).resolves.toMatchObject({
      expiresAt: new Date(claimsExpiresAt * 1000).toISOString()
    });
  });

  it('does not migrate when the supplied stored password is invalid', async () => {
    const { service, serviceClient } = await createService({
      storedPassword: 'AnotherPassword123!'
    });

    await expect(service.login('admin', password)).rejects.toThrow(
      new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。')
    );
    expect(serviceClient.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('does not fall back to the stored password after a successful Supabase login was recorded', async () => {
    const { service, serviceClient } = await createService({
      mustResetPassword: true,
      lastAuthenticatedAt: new Date()
    });

    await expect(service.login('admin', password)).rejects.toThrow(
      new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。')
    );
    expect(serviceClient.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('keeps an existing Supabase password without invoking stored-password migration', async () => {
    const { service, serviceClient } = await createService({
      initialSignInSucceeds: true,
      verifiedFactor: true
    });

    await expect(service.login('admin', password, '000000')).resolves.toEqual(
      expect.objectContaining({
        userId
      })
    );
    expect(serviceClient.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('fails closed and revokes the temporary session when MFA factors cannot be confirmed', async () => {
    const { service, serviceClient } = await createService({
      factorListFails: true,
      initialSignInSucceeds: true
    });

    await expect(service.login('admin', password)).rejects.toThrow(
      new ServiceUnavailableException('Supabase MFA 状态暂时无法确认，请稍后重试。')
    );
    expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, 'local');
  });

  it('rejects and revokes a password session when no verified TOTP factor is bound', async () => {
    const { service, serviceClient } = await createService({
      initialSignInSucceeds: true
    });

    await expect(service.login('admin', password)).rejects.toThrow(
      new UnauthorizedException('当前账号尚未绑定 Supabase 动态验证码，请联系管理员完成绑定。')
    );
    expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, 'local');
  });

  it('revokes the temporary session when a verified factor has no code', async () => {
    const { service, serviceClient } = await createService({
      initialSignInSucceeds: true,
      verifiedFactor: true
    });

    await expect(service.login('admin', password)).rejects.toThrow(
      new UnauthorizedException('需要输入 6 位动态验证码。')
    );
    expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, 'local');
  });

  it('revokes the temporary session when MFA verification fails', async () => {
    const { service, serviceClient } = await createService({
      initialSignInSucceeds: true,
      mfaVerificationFails: true,
      verifiedFactor: true
    });

    await expect(service.login('admin', password, '000000')).rejects.toThrow(
      new UnauthorizedException('6 位动态验证码错误，请重新输入。')
    );
    expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, 'local');
  });

  it('revokes an otherwise authenticated session when its stable session id is missing', async () => {
    const { service, serviceClient, loginSession } = await createService({
      initialSignInSucceeds: true,
      loginSessionIdMissing: true,
      verifiedFactor: true
    });

    await expect(service.login('admin', password, '000000')).rejects.toThrow(
      new ServiceUnavailableException('Supabase 登录会话缺少稳定会话标识。')
    );
    expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(
      loginSession.access_token,
      'local'
    );
  });

  it('deduplicates concurrent token verification and reuses the verified identity cache', async () => {
    const { service, prisma, publicClient } = await createService();

    await expect(
      Promise.all([
        service.authenticateAccessToken(session.access_token),
        service.authenticateAccessToken(session.access_token)
      ])
    ).resolves.toEqual([
      {
        userId,
        sessionId: providerSessionId,
        expiresAt: new Date(expiresAtSeconds * 1000)
      },
      {
        userId,
        sessionId: providerSessionId,
        expiresAt: new Date(expiresAtSeconds * 1000)
      }
    ]);
    await expect(service.authenticateAccessToken(session.access_token)).resolves.toEqual({
      userId,
      sessionId: providerSessionId,
      expiresAt: new Date(expiresAtSeconds * 1000)
    });

    expect(publicClient.auth.getClaims).toHaveBeenCalledTimes(1);
    expect(prisma.v2AuthIdentity.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rejects an access token when Supabase cannot verify its claims', async () => {
    const { service, prisma } = await createService({
      claimsValid: false
    });

    await expect(service.authenticateAccessToken('invalid-token')).rejects.toThrow(
      new UnauthorizedException('登录状态无效或已过期，请重新登录。')
    );
    expect(prisma.v2AuthIdentity.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a verified token whose claims are already expired', async () => {
    const { service, prisma } = await createService({
      claimsExpiresAt: Math.floor(Date.now() / 1000) - 1
    });

    await expect(service.authenticateAccessToken(accessToken)).rejects.toThrow(
      new UnauthorizedException('登录状态无效或已过期，请重新登录。')
    );
    expect(prisma.v2AuthIdentity.findFirst).toHaveBeenCalledTimes(1);
  });

  it('verifies the current password against Supabase and closes the temporary session', async () => {
    const { service, publicClient, serviceClient } = await createService({
      initialSignInSucceeds: true
    });

    await expect(service.verifyCurrentPassword(userId, password)).resolves.toEqual({
      authEmail,
      authUserId
    });

    expect(publicClient.auth.signInWithPassword).toHaveBeenCalledWith({
      email: authEmail,
      password
    });
    expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, 'local');
  });

  it('rejects a current password that Supabase does not accept', async () => {
    const { service, serviceClient } = await createService();

    await expect(service.verifyCurrentPassword(userId, password)).rejects.toThrow(
      new BadRequestException('当前密码不正确，请重新输入。')
    );
    expect(serviceClient.auth.admin.signOut).not.toHaveBeenCalled();
  });

  it('rejects a Supabase login whose returned Auth user does not match the bound identity', async () => {
    const { service, serviceClient } = await createService({
      initialSignInSucceeds: true,
      loginAuthUserId: '66666666-6666-4666-8666-666666666666'
    });

    await expect(service.login('admin', password)).rejects.toThrow(
      new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。')
    );
    expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, 'local');
  });

  it.each(['phone', 'webauthn'] as const)(
    'fails closed for a verified %s-only MFA account',
    async (verifiedFactorType) => {
      const { service, serviceClient } = await createService({
        initialSignInSucceeds: true,
        verifiedFactor: true,
        verifiedFactorType
      });

      await expect(service.login('admin', password, '000000')).rejects.toThrow(
        new UnauthorizedException('当前账号需要使用受支持的二次验证方式。')
      );
      expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, 'local');
    }
  );

  it('rejects a TOTP login whose verified session remains at AAL1', async () => {
    const { service, serviceClient } = await createService({
      claimsAal: 'aal1',
      initialSignInSucceeds: true,
      verifiedFactor: true
    });

    await expect(service.login('admin', password, '000000')).rejects.toThrow(
      new ServiceUnavailableException('Supabase 登录会话缺少稳定会话标识。')
    );
    expect(serviceClient.auth.admin.signOut).toHaveBeenCalledWith(session.access_token, 'local');
  });

  it('confirms a password update that succeeded before an ambiguous provider response', async () => {
    const { service, publicClient, serviceClient } = await createService();
    serviceClient.auth.admin.updateUserById.mockRejectedValue(new Error('response lost'));
    publicClient.auth.signInWithPassword
      .mockReset()
      .mockResolvedValueOnce({
        data: { session },
        error: null
      })
      .mockResolvedValueOnce({
        data: { session: null },
        error: {
          code: 'invalid_credentials',
          status: 400
        }
      });

    await expect(
      service.setPasswordWithConfirmation({
        alternatePassword: password,
        authEmail,
        authUserId,
        desiredPassword: 'NewPassword456!'
      })
    ).resolves.toBe('desired_confirmed');
    expect(serviceClient.auth.admin.updateUserById).toHaveBeenCalledTimes(2);
  });
});
