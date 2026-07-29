import { UnauthorizedException } from '@nestjs/common';
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
  const password = 'ExistingAdminPassword123!';
  const authEmail = 'admin-3333333333334333@v2-auth.invalid';
  const session = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    expires_at: 1_800_000_000,
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
  }) {
    const passwordHash = await hashPassword(options?.storedPassword ?? password);
    const identity = {
      authEmail,
      authUserId,
      userId,
      mustResetPassword: options?.mustResetPassword ?? true,
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
                    exp: Math.floor(Date.now() / 1000) + 3600
                  }
                },
                error: null
              }
        ),
        signInWithPassword: vi
          .fn()
          .mockResolvedValueOnce(
            options?.initialSignInSucceeds
              ? { data: { session }, error: null }
              : { data: { session: null }, error: { message: 'invalid credentials' } }
          )
          .mockResolvedValue({ data: { session }, error: null }),
        mfa: {
          listFactors: vi.fn().mockResolvedValue({
            data: {
              totp: []
            }
          })
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
      serviceClient
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrates the stored password once and then signs in through Supabase Auth', async () => {
    const { service, prisma, publicClient, serviceClient } = await createService();

    await expect(service.login('admin', password)).resolves.toEqual({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
      userId
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
        lastAuthenticatedAt: expect.any(Date),
        mustResetPassword: false
      }
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

  it('does not fall back to the stored password after migration is complete', async () => {
    const { service, serviceClient } = await createService({
      mustResetPassword: false
    });

    await expect(service.login('admin', password)).rejects.toThrow(
      new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。')
    );
    expect(serviceClient.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('keeps an existing Supabase password without invoking stored-password migration', async () => {
    const { service, serviceClient } = await createService({
      initialSignInSucceeds: true
    });

    await expect(service.login('admin', password)).resolves.toEqual(
      expect.objectContaining({
        userId
      })
    );
    expect(serviceClient.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent token verification and reuses the verified identity cache', async () => {
    const { service, prisma, publicClient } = await createService();

    await expect(
      Promise.all([
        service.authenticateAccessToken(session.access_token),
        service.authenticateAccessToken(session.access_token)
      ])
    ).resolves.toEqual([userId, userId]);
    await expect(service.authenticateAccessToken(session.access_token)).resolves.toBe(userId);

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
});
