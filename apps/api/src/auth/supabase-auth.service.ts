import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { verifyPassword } from './password-hasher';

interface CachedIdentity {
  userId: string;
  expiresAt: number;
}

export interface SupabaseLoginResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
}

const ACCESS_TOKEN_CACHE_TTL_MS = 30_000;
const VERIFIED_TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_EXPIRY_SAFETY_MS = 5_000;

@Injectable()
export class SupabaseAuthService {
  private readonly tokenIdentityCache = new Map<string, CachedIdentity>();
  private readonly pendingAuthentications = new Map<string, Promise<string>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService
  ) {}

  isEnabled() {
    return this.configService.get<string>('AUTH_PROVIDER') === 'supabase';
  }

  async login(username: string, password: string, mfaCode?: string): Promise<SupabaseLoginResult> {
    const normalizedUsername = username.trim().toLowerCase();
    const identity = await this.prisma.v2AuthIdentity.findFirst({
      where: {
        usernameNormalized: normalizedUsername,
        enabled: true,
        user: {
          status: 'active',
          deletedAt: null
        }
      },
      select: {
        authEmail: true,
        authUserId: true,
        userId: true,
        mustResetPassword: true,
        user: {
          select: {
            passwordHash: true
          }
        }
      }
    });

    if (!identity) {
      throw new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。');
    }

    const client = this.createPublicClient();
    let signInResult = await client.auth.signInWithPassword({
      email: identity.authEmail,
      password
    });
    if (
      (signInResult.error || !signInResult.data.session) &&
      identity.mustResetPassword &&
      (await verifyPassword(password, identity.user.passwordHash))
    ) {
      await this.migrateStoredPassword(identity.authUserId, password);
      signInResult = await client.auth.signInWithPassword({
        email: identity.authEmail,
        password
      });
    }

    if (signInResult.error || !signInResult.data.session) {
      throw new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。');
    }

    let session = signInResult.data.session;
    const factorResult = await client.auth.mfa.listFactors();
    const verifiedFactor = factorResult.data?.totp.find((factor) => factor.status === 'verified');
    if (verifiedFactor) {
      const code = mfaCode?.trim();
      if (!code) {
        throw new UnauthorizedException('需要输入动态验证码或恢复码。');
      }

      const verifyResult = await client.auth.mfa.challengeAndVerify({
        factorId: verifiedFactor.id,
        code
      });
      if (verifyResult.error || !verifyResult.data) {
        throw new UnauthorizedException('动态验证码或恢复码错误，请重新输入。');
      }
      session = {
        access_token: verifyResult.data.access_token,
        refresh_token: verifyResult.data.refresh_token,
        expires_in: verifyResult.data.expires_in,
        expires_at: Math.floor(Date.now() / 1000) + verifyResult.data.expires_in,
        token_type: verifyResult.data.token_type,
        user: verifyResult.data.user
      };
    }

    await this.prisma.v2AuthIdentity.update({
      where: {
        userId: identity.userId
      },
      data: {
        lastAuthenticatedAt: new Date(),
        mustResetPassword: false
      }
    });

    this.cacheIdentity(session.access_token, identity.userId);
    return this.toLoginResult(session, identity.userId);
  }

  async authenticateAccessToken(accessToken: string) {
    const cacheKey = this.hashToken(accessToken);
    const cached = this.tokenIdentityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.userId;
    }

    const pending = this.pendingAuthentications.get(cacheKey);
    if (pending) return pending;

    const authentication = this.verifyAccessToken(accessToken, cacheKey).finally(() => {
      this.pendingAuthentications.delete(cacheKey);
    });
    this.pendingAuthentications.set(cacheKey, authentication);
    return authentication;
  }

  private async verifyAccessToken(accessToken: string, cacheKey: string) {
    const client = this.createPublicClient();
    const claimsResult = await client.auth.getClaims(accessToken);
    const claims = claimsResult.data?.claims;
    const authUserId = claims?.sub;
    if (claimsResult.error || !claims || !authUserId) {
      this.tokenIdentityCache.delete(cacheKey);
      throw new UnauthorizedException('登录状态无效或已过期，请重新登录。');
    }

    const identity = await this.prisma.v2AuthIdentity.findFirst({
      where: {
        authUserId,
        enabled: true,
        user: {
          status: 'active',
          deletedAt: null
        }
      },
      select: {
        userId: true
      }
    });
    if (!identity) {
      throw new UnauthorizedException('登录账号未绑定到业务系统或已停用。');
    }

    this.cacheIdentity(accessToken, identity.userId, this.getVerifiedTokenCacheExpiry(claims.exp));
    return identity.userId;
  }

  async logout(accessToken?: string) {
    if (!accessToken) return;

    const cacheKey = this.hashToken(accessToken);
    this.tokenIdentityCache.delete(cacheKey);
    this.pendingAuthentications.delete(cacheKey);
    const client = this.createServiceClient();
    const result = await client.auth.admin.signOut(accessToken, 'local');
    if (result.error && result.error.status !== 404) {
      throw new ServiceUnavailableException('Supabase 登录会话注销失败，请稍后重试。');
    }
  }

  private createPublicClient() {
    const { url, anonKey } = this.getConfig();
    return createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      }
    });
  }

  private createServiceClient(): SupabaseClient {
    const { url, serviceRoleKey } = this.getConfig();
    return createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false
      }
    });
  }

  private async migrateStoredPassword(authUserId: string, password: string) {
    const result = await this.createServiceClient().auth.admin.updateUserById(authUserId, {
      password
    });
    if (result.error) {
      throw new ServiceUnavailableException('管理员密码安全迁移暂时不可用，请稍后重试。');
    }
  }

  private getConfig() {
    const url = this.configService.get<string>('SUPABASE_URL');
    const anonKey =
      this.configService.get<string>('SUPABASE_ANON_KEY') ??
      this.configService.get<string>('SUPABASE_PUBLISHABLE_KEY');
    const serviceRoleKey =
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') ??
      this.configService.get<string>('SUPABASE_SECRET_KEY');

    if (!url || !anonKey || !serviceRoleKey) {
      throw new ServiceUnavailableException('Supabase Auth 环境变量尚未完整配置。');
    }

    return {
      url: url.replace(/\/$/, ''),
      anonKey,
      serviceRoleKey
    };
  }

  private toLoginResult(session: Session, userId: string): SupabaseLoginResult {
    const expiresAtSeconds =
      session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in;
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      userId
    };
  }

  private cacheIdentity(accessToken: string, userId: string, expiresAt?: number) {
    this.tokenIdentityCache.set(this.hashToken(accessToken), {
      userId,
      expiresAt: expiresAt ?? Date.now() + ACCESS_TOKEN_CACHE_TTL_MS
    });
  }

  private getVerifiedTokenCacheExpiry(exp?: number) {
    const cacheExpiry = Date.now() + VERIFIED_TOKEN_CACHE_TTL_MS;
    if (!exp || !Number.isFinite(exp)) return cacheExpiry;
    return Math.max(Date.now(), Math.min(cacheExpiry, exp * 1000 - TOKEN_EXPIRY_SAFETY_MS));
  }

  private hashToken(accessToken: string) {
    return createHash('sha256').update(accessToken).digest('hex');
  }
}
