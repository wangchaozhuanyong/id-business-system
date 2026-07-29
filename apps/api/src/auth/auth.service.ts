import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SecurityService } from '../security/security.service';
import { V2IdentityService } from '../v2-auth/v2-identity.service';
import { verifyPassword } from './password-hasher';
import { SupabaseAuthService } from './supabase-auth.service';
import type { AuthenticatedUser, JwtPayload } from './auth.types';
import type { LoginDto } from './dto/login.dto';

interface LoginRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly identityService: V2IdentityService,
    private readonly auditLogsService: AuditLogsService,
    private readonly securityService: SecurityService,
    @Optional() private readonly supabaseAuthService?: SupabaseAuthService
  ) {}

  async login(dto: LoginDto, requestMeta?: LoginRequestMeta) {
    const ipAllowed = await this.securityService.isRequestIpAllowed(requestMeta?.ip, [
      'admin',
      'api'
    ]);
    if (!ipAllowed) {
      await this.securityService.recordLoginAttempt({
        username: dto.username,
        status: 'blocked',
        failureReason: 'ip_not_allowed',
        ip: requestMeta?.ip,
        userAgent: requestMeta?.userAgent
      });
      throw new UnauthorizedException('当前 IP 不在白名单内，无法登录。');
    }

    if (this.supabaseAuthService?.isEnabled()) {
      return this.loginWithSupabase(dto, requestMeta);
    }

    const user = await this.prisma.user.findFirst({
      where: {
        username: dto.username,
        deletedAt: null
      }
    });

    if (!user || user.status !== 'active') {
      await this.securityService.recordLoginAttempt({
        username: dto.username,
        userId: user?.id ?? null,
        status: user ? 'blocked' : 'failed',
        failureReason: user ? `user_status_${user.status}` : 'user_not_found',
        ip: requestMeta?.ip,
        userAgent: requestMeta?.userAgent
      });
      throw new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。');
    }

    const passwordValid = await verifyPassword(dto.password, user.passwordHash);
    if (!passwordValid) {
      await this.securityService.recordLoginAttempt({
        username: dto.username,
        userId: user.id,
        status: 'failed',
        failureReason: 'password_invalid',
        ip: requestMeta?.ip,
        userAgent: requestMeta?.userAgent
      });
      throw new UnauthorizedException('账号或密码错误，请检查账号和密码后重试。');
    }

    const authenticatedUser = await this.identityService.getAuthenticatedUser(user.id);
    const mfaRequirement =
      await this.securityService.getMfaLoginRequirementForUser(authenticatedUser);
    if (mfaRequirement.required) {
      if (!mfaRequirement.bound) {
        await this.securityService.recordLoginAttempt({
          username: dto.username,
          userId: user.id,
          status: 'blocked',
          failureReason: 'mfa_not_bound',
          ip: requestMeta?.ip,
          userAgent: requestMeta?.userAgent
        });
        throw new UnauthorizedException(
          '管理员账号必须先绑定 MFA 后才能登录，请联系已登录管理员处理。'
        );
      }

      const mfaCode = dto.mfaCode?.trim();
      if (!mfaCode) {
        await this.securityService.recordLoginAttempt({
          username: dto.username,
          userId: user.id,
          status: 'blocked',
          failureReason: 'mfa_required',
          ip: requestMeta?.ip,
          userAgent: requestMeta?.userAgent
        });
        throw new UnauthorizedException('需要输入动态验证码或恢复码。');
      }

      try {
        await this.securityService.verifyUserMfaCode(user.id, mfaCode);
      } catch {
        await this.securityService.recordLoginAttempt({
          username: dto.username,
          userId: user.id,
          status: 'blocked',
          failureReason: 'mfa_invalid',
          ip: requestMeta?.ip,
          userAgent: requestMeta?.userAgent
        });
        throw new UnauthorizedException('动态验证码或恢复码错误，请重新输入。');
      }
    }

    const response = this.createAuthResponse(authenticatedUser);

    await this.securityService.createActiveSession({
      userId: user.id,
      accessToken: response.accessToken,
      expiresAt: this.getTokenExpiresAt(response.accessToken),
      ip: requestMeta?.ip,
      userAgent: requestMeta?.userAgent
    });

    await Promise.all([
      this.prisma.user.update({
        where: {
          id: user.id
        },
        data: {
          lastLoginAt: new Date()
        }
      }),
      this.auditLogsService.create({
        userId: user.id,
        module: 'auth',
        action: 'login',
        objectType: 'user',
        objectId: user.id,
        remark: 'User logged in'
      }),
      this.securityService.recordLoginAttempt({
        username: user.username,
        userId: user.id,
        status: 'success',
        ip: requestMeta?.ip,
        userAgent: requestMeta?.userAgent
      })
    ]).catch(() => undefined);

    return response;
  }

  async logout(accessToken?: string, user?: AuthenticatedUser) {
    if (this.supabaseAuthService?.isEnabled()) {
      await this.supabaseAuthService.logout(accessToken);
      if (user) {
        await this.auditLogsService.create({
          userId: user.id,
          module: 'auth',
          action: 'logout',
          objectType: 'user',
          objectId: user.id,
          remark: 'User logged out through Supabase Auth'
        });
      }
      return {
        loggedOut: true
      };
    }

    if (accessToken) {
      await this.securityService.revokeAccessToken(accessToken, user);
    }

    return {
      loggedOut: true
    };
  }

  async refresh(user: AuthenticatedUser, requestMeta?: LoginRequestMeta) {
    const response = this.createAuthResponse(user);
    await this.securityService.createActiveSession({
      userId: user.id,
      accessToken: response.accessToken,
      expiresAt: this.getTokenExpiresAt(response.accessToken),
      ip: requestMeta?.ip,
      userAgent: requestMeta?.userAgent
    });

    return response;
  }

  private createAuthResponse(user: AuthenticatedUser) {
    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      jti: randomUUID()
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user
    };
  }

  private async loginWithSupabase(dto: LoginDto, requestMeta?: LoginRequestMeta) {
    try {
      const session = await this.supabaseAuthService!.login(
        dto.username,
        dto.password,
        dto.mfaCode ?? undefined
      );
      const authenticatedUser = await this.identityService.getAuthenticatedUser(session.userId);

      await Promise.all([
        this.prisma.user.update({
          where: {
            id: authenticatedUser.id
          },
          data: {
            lastLoginAt: new Date()
          }
        }),
        this.auditLogsService.create({
          userId: authenticatedUser.id,
          module: 'auth',
          action: 'login',
          objectType: 'user',
          objectId: authenticatedUser.id,
          remark: 'User logged in through Supabase Auth'
        }),
        this.securityService.recordLoginAttempt({
          username: authenticatedUser.username,
          userId: authenticatedUser.id,
          status: 'success',
          ip: requestMeta?.ip,
          userAgent: requestMeta?.userAgent
        })
      ]).catch(() => undefined);

      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: session.expiresAt,
        user: authenticatedUser
      };
    } catch (error) {
      await this.securityService
        .recordLoginAttempt({
          username: dto.username,
          status: 'failed',
          failureReason: 'supabase_auth_failed',
          ip: requestMeta?.ip,
          userAgent: requestMeta?.userAgent
        })
        .catch(() => undefined);
      throw error;
    }
  }

  private getTokenExpiresAt(accessToken: string) {
    const payloadPart = accessToken.split('.')[1];
    if (!payloadPart) {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }

    try {
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
        exp?: number;
      };
      return payload.exp
        ? new Date(payload.exp * 1000)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    } catch {
      return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }
  }
}
