import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { authHttpError } from '../common/errors/api-http.exception';
import { SecurityService } from '../security/security.service';
import { V2IdentityService } from '../v2-auth/v2-identity.service';
import type { ChangePasswordDto } from './dto/change-password.dto';
import { hashPassword, verifyPassword } from './password-hasher';
import { SupabaseAuthService } from './supabase-auth.service';
import type { AuthenticatedUser, JwtPayload } from './auth.types';
import type { LoginDto } from './dto/login.dto';

interface LoginRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

type ProviderCompensationStatus =
  'not_needed' | 'succeeded' | 'failed' | 'local_committed' | 'skipped_newer_change';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
      throw authHttpError(
        HttpStatus.FORBIDDEN,
        'AUTH_IP_BLOCKED',
        '当前 IP 不在白名单内，无法登录。'
      );
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
    const supabaseAuthService = this.supabaseAuthService;
    if (supabaseAuthService?.isEnabled()) {
      const localRevocation = async () => {
        if (!accessToken) return;
        const identity = await supabaseAuthService.authenticateAccessToken(accessToken);
        await this.securityService.revokeSessionIdentifier(
          this.getSupabaseSessionIdentifier(identity.sessionId),
          user
        );
      };
      const [localResult, providerResult] = await Promise.allSettled([
        localRevocation(),
        supabaseAuthService.logout(accessToken)
      ]);
      const failedStages = [
        localResult.status === 'rejected' ? 'local_session' : null,
        providerResult.status === 'rejected' ? 'supabase_session' : null
      ].filter((stage): stage is string => Boolean(stage));

      if (failedStages.length) {
        await this.recordLogoutFailure(user, failedStages);
        throw new ServiceUnavailableException(
          '注销未完全完成，本机登录信息将被清除；请重新登录后在安全中心确认其他会话。'
        );
      }

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
    if (this.supabaseAuthService?.isEnabled()) {
      throw new BadRequestException('Supabase 登录会话由客户端安全刷新。');
    }

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

  async changePassword(
    dto: ChangePasswordDto,
    accessToken: string | undefined,
    user: AuthenticatedUser
  ) {
    const currentPassword = this.normalizePassword(dto.currentPassword, '当前密码');
    const newPassword = this.normalizePassword(dto.newPassword, '新密码');
    if (currentPassword === newPassword) {
      throw new BadRequestException('新密码不能与当前密码相同。');
    }
    await this.securityService.assertPasswordMeetsPolicy(newPassword);

    const changeId = randomUUID();
    const passwordHash = await hashPassword(newPassword);
    let supabaseAuthUserId: string | null = null;
    let providerPasswordUpdated = false;
    let providerCompensation: ProviderCompensationStatus = 'not_needed';
    try {
      await this.prisma.$transaction(
        async (transaction: Prisma.TransactionClient) => {
          await transaction.$queryRaw`
            SELECT 1::integer AS "locked"
            FROM (
              SELECT pg_advisory_xact_lock(
                hashtextextended(${`auth-password:${user.id}`}, 0)
              )
            ) AS "password_lock"
          `;
          const currentUser = await transaction.user.findFirst({
            where: {
              id: user.id,
              status: 'active',
              deletedAt: null
            },
            select: {
              id: true,
              passwordHash: true
            }
          });
          if (!currentUser) {
            throw new BadRequestException('当前密码不正确，请重新输入。');
          }

          if (this.supabaseAuthService?.isEnabled()) {
            const identity = await this.supabaseAuthService.verifyCurrentPassword(
              user.id,
              currentPassword
            );
            supabaseAuthUserId = identity.authUserId;
            await this.supabaseAuthService.updatePassword(identity.authUserId, newPassword);
            providerPasswordUpdated = true;
          } else if (!(await verifyPassword(currentPassword, currentUser.passwordHash))) {
            throw new BadRequestException('当前密码不正确，请重新输入。');
          }

          try {
            await this.persistPasswordChange(transaction, user.id, passwordHash, changeId);
          } catch (error) {
            if (providerPasswordUpdated && supabaseAuthUserId && this.supabaseAuthService) {
              try {
                await this.supabaseAuthService.updatePassword(supabaseAuthUserId, currentPassword);
                providerCompensation = 'succeeded';
              } catch {
                providerCompensation = 'failed';
              }
            }
            throw error;
          }
        },
        {
          maxWait: 5_000,
          timeout: 20_000
        }
      );
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof UnauthorizedException) {
        throw error;
      }

      if (
        providerPasswordUpdated &&
        providerCompensation === 'not_needed' &&
        supabaseAuthUserId &&
        this.supabaseAuthService
      ) {
        providerCompensation = await this.reconcileProviderPasswordAfterTransactionFailure({
          currentPassword,
          newPassword,
          supabaseAuthUserId,
          userId: user.id
        });
      }

      await this.recordPasswordChangeFailure({
        changeId,
        providerCompensation,
        providerPasswordUpdated,
        userId: user.id
      });
      if (error instanceof ServiceUnavailableException && !providerPasswordUpdated) {
        throw error;
      }

      throw new ServiceUnavailableException(
        `密码更新未完成（参考编号 ${changeId}），请分别尝试当前密码和新密码重新登录；仍无法登录时请联系管理员。`,
        {
          cause: error
        }
      );
    }

    this.identityService.invalidateAuthenticatedUser(user.id);
    this.securityService.invalidateActiveSessionCache();
    let providerSignedOut = true;
    if (this.supabaseAuthService?.isEnabled()) {
      providerSignedOut = await this.supabaseAuthService
        .logout(accessToken, 'global')
        .then(() => true)
        .catch(() => false);
      if (!providerSignedOut) {
        await this.recordPasswordChangeProviderLogoutFailure(user.id, changeId);
      }
    }

    return {
      passwordChanged: true,
      signedOut: true,
      providerSignedOut
    };
  }

  private async persistPasswordChange(
    transaction: Prisma.TransactionClient,
    userId: string,
    passwordHash: string,
    changeId: string
  ) {
    await transaction.user.update({
      where: { id: userId },
      data: {
        passwordHash
      }
    });
    await transaction.v2AuthIdentity.updateMany({
      where: { userId },
      data: {
        mustResetPassword: false
      }
    });
    const revokedAt = new Date();
    const revokedSessions = await transaction.activeSession.updateMany({
      where: {
        userId,
        revokedAt: null
      },
      data: {
        revokedAt
      }
    });
    await transaction.auditLog.create({
      data: {
        userId,
        module: 'auth',
        action: 'change_password',
        objectType: 'user',
        objectId: userId,
        afterData: {
          changeId,
          mustResetPassword: false,
          revokedSessionCount: revokedSessions.count
        },
        remark: 'User changed password and revoked active sessions'
      }
    });
  }

  private async reconcileProviderPasswordAfterTransactionFailure(input: {
    currentPassword: string;
    newPassword: string;
    supabaseAuthUserId: string;
    userId: string;
  }): Promise<ProviderCompensationStatus> {
    try {
      return await this.prisma.$transaction(
        async (transaction: Prisma.TransactionClient) => {
          await transaction.$queryRaw`
            SELECT 1::integer AS "locked"
            FROM (
              SELECT pg_advisory_xact_lock(
                hashtextextended(${`auth-password:${input.userId}`}, 0)
              )
            ) AS "password_lock"
          `;
          const currentUser = await transaction.user.findFirst({
            where: {
              id: input.userId,
              deletedAt: null
            },
            select: {
              passwordHash: true
            }
          });
          if (!currentUser) return 'skipped_newer_change';
          if (await verifyPassword(input.newPassword, currentUser.passwordHash)) {
            return 'local_committed';
          }
          if (!(await verifyPassword(input.currentPassword, currentUser.passwordHash))) {
            return 'skipped_newer_change';
          }

          try {
            await this.supabaseAuthService!.updatePassword(
              input.supabaseAuthUserId,
              input.currentPassword
            );
            return 'succeeded';
          } catch {
            return 'failed';
          }
        },
        {
          maxWait: 5_000,
          timeout: 20_000
        }
      );
    } catch {
      return 'failed';
    }
  }

  private async recordPasswordChangeFailure(input: {
    changeId: string;
    providerCompensation: ProviderCompensationStatus;
    providerPasswordUpdated: boolean;
    userId: string;
  }) {
    const recorded = await this.auditLogsService
      .create({
        userId: input.userId,
        module: 'auth',
        action: 'change_password_failed',
        objectType: 'user',
        objectId: input.userId,
        afterData: {
          changeId: input.changeId,
          providerCompensation: input.providerCompensation,
          providerPasswordUpdated: input.providerPasswordUpdated
        },
        remark: 'Password change failed without logging password material'
      })
      .then(() => true)
      .catch(() => false);

    if (
      !recorded ||
      input.providerCompensation === 'failed' ||
      input.providerCompensation === 'skipped_newer_change'
    ) {
      this.logger.error(
        `Password change failure requires review: changeId=${input.changeId} userId=${input.userId} compensation=${input.providerCompensation}`
      );
    }
  }

  private async recordLogoutFailure(user: AuthenticatedUser | undefined, failedStages: string[]) {
    const recorded = await this.auditLogsService
      .create({
        userId: user?.id,
        module: 'auth',
        action: 'logout_failed',
        objectType: user ? 'user' : undefined,
        objectId: user?.id,
        afterData: {
          failedStages
        },
        remark: 'Logout did not revoke every session layer'
      })
      .then(() => true)
      .catch(() => false);

    if (!recorded) {
      this.logger.error(
        `Logout failure could not be audited: userId=${user?.id ?? 'unknown'} stages=${failedStages.join(',')}`
      );
    }
  }

  private async recordPasswordChangeProviderLogoutFailure(userId: string, changeId: string) {
    const recorded = await this.auditLogsService
      .create({
        userId,
        module: 'auth',
        action: 'change_password_provider_logout_failed',
        objectType: 'user',
        objectId: userId,
        afterData: {
          changeId,
          businessSessionsRevoked: true
        },
        remark: 'Password changed but Supabase global logout requires follow-up'
      })
      .then(() => true)
      .catch(() => false);

    if (!recorded) {
      this.logger.error(
        `Password changed but provider logout failure could not be audited: changeId=${changeId} userId=${userId}`
      );
    }
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
      try {
        await this.securityService.createProviderActiveSession({
          userId: authenticatedUser.id,
          sessionIdentifier: this.getSupabaseSessionIdentifier(session.sessionId),
          expiresAt: new Date(session.expiresAt),
          ip: requestMeta?.ip,
          userAgent: requestMeta?.userAgent
        });
      } catch (error) {
        await this.supabaseAuthService!.logout(session.accessToken).catch(() => undefined);
        throw new ServiceUnavailableException('登录会话登记失败，请重新登录。', {
          cause: error
        });
      }

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

  private getSupabaseSessionIdentifier(sessionId: string) {
    return `supabase:${sessionId}`;
  }

  private normalizePassword(value: string | undefined, label: string) {
    if (typeof value !== 'string' || !value || value.length > 160) {
      throw new BadRequestException(`${label}格式不正确。`);
    }
    return value;
  }
}
