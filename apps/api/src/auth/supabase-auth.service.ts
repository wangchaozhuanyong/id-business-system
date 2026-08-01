import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { authHttpError } from '../common/errors/api-http.exception';
import { PrismaService } from '../common/prisma/prisma.service';
import { verifyPassword } from './password-hasher';

interface CachedIdentity {
  identity: SupabaseSessionIdentity;
  expiresAt: number;
}

export interface SupabaseSessionIdentity {
  userId: string;
  sessionId: string;
  expiresAt: Date;
}

export interface SupabaseLoginResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
  sessionId: string;
}

export interface CreateManagedAuthUserInput {
  email: string;
  password: string;
  username: string;
  displayName: string;
}

const ACCESS_TOKEN_CACHE_TTL_MS = 30_000;
const VERIFIED_TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_EXPIRY_SAFETY_MS = 5_000;

@Injectable()
export class SupabaseAuthService {
  private readonly tokenIdentityCache = new Map<string, CachedIdentity>();
  private readonly pendingAuthentications = new Map<string, Promise<SupabaseSessionIdentity>>();

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
        lastAuthenticatedAt: true,
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
      !identity.lastAuthenticatedAt &&
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
    if (factorResult.error || !factorResult.data) {
      await this.logout(session.access_token).catch(() => undefined);
      throw new ServiceUnavailableException('Supabase MFA 状态暂时无法确认，请稍后重试。');
    }
    const verifiedFactor = factorResult.data?.totp.find((factor) => factor.status === 'verified');
    if (verifiedFactor) {
      const code = mfaCode?.trim();
      if (!code) {
        await this.logout(session.access_token).catch(() => undefined);
        throw new UnauthorizedException('需要输入动态验证码或恢复码。');
      }

      const verifyResult = await client.auth.mfa.challengeAndVerify({
        factorId: verifiedFactor.id,
        code
      });
      if (verifyResult.error || !verifyResult.data) {
        await this.logout(session.access_token).catch(() => undefined);
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
        lastAuthenticatedAt: new Date()
      }
    });

    let sessionIdentity: SupabaseSessionIdentity;
    try {
      sessionIdentity = this.getSessionIdentityFromAccessToken(
        session.access_token,
        identity.userId
      );
    } catch (error) {
      await this.logout(session.access_token).catch(() => undefined);
      throw error;
    }
    this.cacheIdentity(session.access_token, sessionIdentity);
    return this.toLoginResult(session, sessionIdentity);
  }

  async authenticateAccessToken(accessToken: string): Promise<SupabaseSessionIdentity> {
    const cacheKey = this.hashToken(accessToken);
    const cached = this.tokenIdentityCache.get(cacheKey);
    if (
      cached &&
      cached.expiresAt > Date.now() &&
      cached.identity.expiresAt.getTime() > Date.now()
    ) {
      return cached.identity;
    }
    this.tokenIdentityCache.delete(cacheKey);

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
    const sessionId = claims?.session_id;
    if (claimsResult.error && (claimsResult.error.status ?? 0) >= 500) {
      throw authHttpError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'AUTH_DEPENDENCY_UNAVAILABLE',
        '登录服务暂时不可用，请稍后重试。',
        claimsResult.error
      );
    }
    if (
      claimsResult.error ||
      !claims ||
      !authUserId ||
      typeof sessionId !== 'string' ||
      !this.isUuid(sessionId)
    ) {
      this.tokenIdentityCache.delete(cacheKey);
      throw authHttpError(
        HttpStatus.UNAUTHORIZED,
        'AUTH_INVALID',
        '登录状态无效或已过期，请重新登录。',
        claimsResult.error ?? undefined
      );
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
      throw authHttpError(
        HttpStatus.UNAUTHORIZED,
        'AUTH_ACCOUNT_DISABLED',
        '登录账号未绑定到业务系统或已停用。'
      );
    }

    const sessionIdentity = {
      userId: identity.userId,
      sessionId,
      expiresAt: this.getClaimsExpiry(claims.exp)
    };
    this.cacheIdentity(accessToken, sessionIdentity, this.getVerifiedTokenCacheExpiry(claims.exp));
    return sessionIdentity;
  }

  async logout(accessToken?: string, scope: 'local' | 'global' = 'local') {
    if (!accessToken) return;

    const cacheKey = this.hashToken(accessToken);
    this.tokenIdentityCache.delete(cacheKey);
    this.pendingAuthentications.delete(cacheKey);
    const client = this.createServiceClient();
    const result = await client.auth.admin.signOut(accessToken, scope);
    if (result.error && result.error.status !== 404) {
      throw new ServiceUnavailableException('Supabase 登录会话注销失败，请稍后重试。');
    }
  }

  async updatePassword(authUserId: string, password: string) {
    const result = await this.createServiceClient().auth.admin.updateUserById(authUserId, {
      password
    });
    if (result.error) {
      throw new ServiceUnavailableException('Supabase 密码更新暂时不可用，请稍后重试。');
    }
  }

  async createManagedUser(input: CreateManagedAuthUserInput) {
    const result = await this.createServiceClient().auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: {
        username: input.username,
        display_name: input.displayName
      }
    });
    if (result.error || !result.data.user) {
      if (result.error?.status === 422) {
        throw new ConflictException('Supabase 登录账号已存在。');
      }
      throw new ServiceUnavailableException('Supabase 员工账号暂时无法开通，请稍后重试。');
    }
    return {
      authUserId: result.data.user.id
    };
  }

  async deleteManagedUser(authUserId: string) {
    const result = await this.createServiceClient().auth.admin.deleteUser(authUserId, false);
    if (result.error && result.error.status !== 404) {
      throw new ServiceUnavailableException('Supabase 员工账号清理失败，请联系管理员。');
    }
  }

  invalidateAccessTokenCache() {
    this.tokenIdentityCache.clear();
    this.pendingAuthentications.clear();
  }

  async verifyCurrentPassword(userId: string, password: string) {
    const identity = await this.prisma.v2AuthIdentity.findFirst({
      where: {
        userId,
        enabled: true,
        user: {
          status: 'active',
          deletedAt: null
        }
      },
      select: {
        authEmail: true,
        authUserId: true
      }
    });

    if (!identity) {
      throw new UnauthorizedException('登录账号未绑定到 Supabase Auth 或已停用。');
    }

    const result = await this.createPublicClient().auth.signInWithPassword({
      email: identity.authEmail,
      password
    });
    const session = result.data.session;
    if (result.error || !session || session.user.id !== identity.authUserId) {
      if (session) {
        await this.logout(session.access_token).catch(() => undefined);
      }
      throw new BadRequestException('当前密码不正确，请重新输入。');
    }

    await this.logout(session.access_token);
    return {
      authUserId: identity.authUserId
    };
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
    await this.updatePassword(authUserId, password);
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

  private toLoginResult(session: Session, identity: SupabaseSessionIdentity): SupabaseLoginResult {
    const expiresAtSeconds =
      session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in;
    return {
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
      userId: identity.userId,
      sessionId: identity.sessionId
    };
  }

  private cacheIdentity(
    accessToken: string,
    identity: SupabaseSessionIdentity,
    expiresAt?: number
  ) {
    const cacheExpiresAt = Math.max(
      Date.now(),
      Math.min(
        expiresAt ?? Date.now() + ACCESS_TOKEN_CACHE_TTL_MS,
        identity.expiresAt.getTime() - TOKEN_EXPIRY_SAFETY_MS
      )
    );
    this.tokenIdentityCache.set(this.hashToken(accessToken), {
      identity,
      expiresAt: cacheExpiresAt
    });
  }

  private getSessionIdentityFromAccessToken(
    accessToken: string,
    userId: string
  ): SupabaseSessionIdentity {
    const payloadPart = accessToken.split('.')[1];
    if (!payloadPart) {
      throw new ServiceUnavailableException('Supabase 登录会话缺少稳定会话标识。');
    }

    try {
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
        exp?: number;
        session_id?: string;
      };
      if (!payload.session_id || !this.isUuid(payload.session_id)) {
        throw new Error('missing session_id');
      }
      return {
        userId,
        sessionId: payload.session_id,
        expiresAt: this.getClaimsExpiry(payload.exp)
      };
    } catch {
      throw new ServiceUnavailableException('Supabase 登录会话缺少稳定会话标识。');
    }
  }

  private getClaimsExpiry(exp?: number) {
    if (!exp || !Number.isFinite(exp) || exp * 1000 <= Date.now()) {
      throw authHttpError(
        HttpStatus.UNAUTHORIZED,
        'AUTH_EXPIRED',
        '登录状态无效或已过期，请重新登录。'
      );
    }
    return new Date(exp * 1000);
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
