import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiHttpException, authHttpError } from '../common/errors/api-http.exception';
import { resolveTrustedClientIp } from '../common/http/trusted-client-ip';
import { recordServerAuthTiming } from '../common/interceptors/server-timing.interceptor';
import { SecurityService } from '../security/security.service';
import { V2IdentityService } from '../v2-auth/v2-identity.service';
import { ALLOW_DURING_PASSWORD_RESET_KEY, IS_PUBLIC_KEY } from './auth.decorators';
import { AuthAvailabilityMonitor } from './auth-availability.monitor';
import { SupabaseAuthService } from './supabase-auth.service';
import type { AuthenticatedUser, JwtPayload } from './auth.types';

interface RequestWithAuthHeader {
  headers: Record<string, string | string[] | undefined> & {
    authorization?: string;
    'user-agent'?: string;
  };
  originalUrl?: string;
  query?: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly identityService: V2IdentityService,
    private readonly securityService: SecurityService,
    private readonly supabaseAuthService: SupabaseAuthService,
    private readonly availabilityMonitor: AuthAvailabilityMonitor
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) return true;

    const allowDuringPasswordReset = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_PASSWORD_RESET_KEY,
      [context.getHandler(), context.getClass()]
    );
    const request = context.switchToHttp().getRequest<RequestWithAuthHeader>();
    const authStartedAt = performance.now();
    const token = this.extractToken(request);
    if (!token) {
      recordServerAuthTiming(request, performance.now() - authStartedAt);
      throw authHttpError(HttpStatus.UNAUTHORIZED, 'AUTH_MISSING', '请先登录后再操作。');
    }

    try {
      if (this.supabaseAuthService.isEnabled()) {
        await this.activateSupabaseSession(request, token, allowDuringPasswordReset);
      } else {
        await this.activateLocalSession(request, token, allowDuringPasswordReset);
      }
      this.availabilityMonitor.recordAvailable();
      return true;
    } catch (error) {
      if (
        error instanceof ApiHttpException &&
        error.getStatus() === HttpStatus.SERVICE_UNAVAILABLE
      ) {
        this.availabilityMonitor.recordUnavailable();
      } else {
        this.availabilityMonitor.recordAvailable();
      }
      throw error;
    } finally {
      recordServerAuthTiming(request, performance.now() - authStartedAt);
    }
  }

  private async activateSupabaseSession(
    request: RequestWithAuthHeader,
    token: string,
    allowDuringPasswordReset: boolean | undefined
  ) {
    const identity = await this.authenticateSupabaseToken(token);
    const clientIp = resolveTrustedClientIp(request);
    await this.assertRequestIpAllowed(clientIp);
    const strongSessionIdentifier = `supabase:mfa:${identity.sessionId}`;
    const ordinarySessionIdentifier = `supabase:${identity.sessionId}`;
    const candidates = identity.mfaVerified
      ? [strongSessionIdentifier, ordinarySessionIdentifier]
      : [ordinarySessionIdentifier, strongSessionIdentifier];
    const activeSessionIdentifier = await this.checkActiveSession(async () => {
      for (const sessionIdentifier of candidates) {
        if (
          await this.securityService.ensureActiveSession({
            userId: identity.userId,
            sessionIdentifier,
            expiresAt: identity.expiresAt,
            ip: clientIp,
            userAgent: request.headers['user-agent']
          })
        ) {
          return sessionIdentifier;
        }
      }
      return null;
    });
    if (!activeSessionIdentifier) throw this.revokedSessionError();

    const user = await this.loadAuthenticatedUser(identity.userId);
    const mfaRequirement = await this.securityService.getMfaLoginRequirementForUser(user);
    if (mfaRequirement.required && activeSessionIdentifier !== strongSessionIdentifier) {
      throw authHttpError(
        HttpStatus.UNAUTHORIZED,
        'AUTH_MFA_REQUIRED',
        '当前会话未完成 MFA 验证，请重新登录。'
      );
    }
    request.user = user;
    this.assertPasswordResetAccess(user, allowDuringPasswordReset);
  }

  private async activateLocalSession(
    request: RequestWithAuthHeader,
    token: string,
    allowDuringPasswordReset: boolean | undefined
  ) {
    const payload = await this.verifyLocalToken(token);
    const active = await this.checkActiveSession(() =>
      this.securityService.isAccessTokenActive(token)
    );
    if (!active) throw this.revokedSessionError();

    const clientIp = resolveTrustedClientIp(request);
    await this.assertRequestIpAllowed(clientIp);
    request.user = await this.loadAuthenticatedUser(payload.sub);
    if (
      (await this.securityService.isMfaRequiredForUser(request.user)) &&
      payload.mfaVerified !== true
    ) {
      throw authHttpError(
        HttpStatus.UNAUTHORIZED,
        'AUTH_MFA_REQUIRED',
        '当前会话未完成 MFA 验证，请重新登录。'
      );
    }
    this.assertPasswordResetAccess(request.user, allowDuringPasswordReset);
  }

  private async authenticateSupabaseToken(token: string) {
    try {
      return await this.supabaseAuthService.authenticateAccessToken(token);
    } catch (error) {
      if (error instanceof ApiHttpException) throw error;
      if (error instanceof UnauthorizedException) {
        throw authHttpError(
          HttpStatus.UNAUTHORIZED,
          'AUTH_INVALID',
          '登录状态无效或已过期，请重新登录。',
          error
        );
      }
      if (error instanceof HttpException && error.getStatus() === HttpStatus.SERVICE_UNAVAILABLE) {
        throw this.authDependencyUnavailable(error);
      }
      throw this.authDependencyUnavailable(error);
    }
  }

  private async verifyLocalToken(token: string) {
    try {
      return await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch (error) {
      const expired = this.getErrorName(error) === 'TokenExpiredError';
      throw authHttpError(
        HttpStatus.UNAUTHORIZED,
        expired ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
        expired ? '登录状态已过期，请重新登录。' : '登录状态无效，请重新登录。',
        error
      );
    }
  }

  private async checkActiveSession<T>(check: () => Promise<T>): Promise<T> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof ApiHttpException) throw error;
      throw this.authDependencyUnavailable(error);
    }
  }

  private async assertRequestIpAllowed(ip: string | undefined) {
    let allowed: boolean;
    try {
      allowed = await this.securityService.isRequestIpAllowed(ip, ['admin', 'api']);
    } catch (error) {
      throw this.authDependencyUnavailable(error);
    }
    if (!allowed) {
      throw authHttpError(
        HttpStatus.FORBIDDEN,
        'AUTH_IP_BLOCKED',
        '当前 IP 不在白名单内，无法访问。'
      );
    }
  }

  private async loadAuthenticatedUser(userId: string) {
    try {
      return await this.identityService.getAuthenticatedUser(userId);
    } catch (error) {
      if (error instanceof ApiHttpException) throw error;
      if (error instanceof NotFoundException || error instanceof UnauthorizedException) {
        throw authHttpError(
          HttpStatus.UNAUTHORIZED,
          'AUTH_ACCOUNT_DISABLED',
          '登录账号不存在或已停用，请联系管理员。',
          error
        );
      }
      throw this.authDependencyUnavailable(error);
    }
  }

  private extractToken(request: RequestWithAuthHeader) {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type === 'Bearer' && token) return token;
    if (!request.originalUrl?.startsWith('/api/realtime/events')) return undefined;

    const queryToken = request.query?.accessToken;
    return Array.isArray(queryToken) ? queryToken[0] : queryToken;
  }

  private assertPasswordResetAccess(
    user: AuthenticatedUser,
    allowDuringPasswordReset: boolean | undefined
  ) {
    if (user.mustResetPassword && !allowDuringPasswordReset) {
      throw authHttpError(
        HttpStatus.FORBIDDEN,
        'AUTH_PASSWORD_RESET_REQUIRED',
        '必须先修改临时密码后才能访问业务功能。'
      );
    }
  }

  private revokedSessionError(cause?: unknown) {
    return authHttpError(
      HttpStatus.UNAUTHORIZED,
      'AUTH_REVOKED',
      '登录状态已过期或已被下线，请重新登录。',
      cause
    );
  }

  private authDependencyUnavailable(cause: unknown) {
    return authHttpError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'AUTH_DEPENDENCY_UNAVAILABLE',
      '登录服务暂时不可用，请稍后重试。',
      cause
    );
  }

  private getErrorName(error: unknown) {
    return error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  }
}
