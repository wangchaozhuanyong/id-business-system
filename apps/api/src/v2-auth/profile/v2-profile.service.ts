import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  SecurityService,
  type DisableMfaInput,
  type ListSessionsQuery,
  type VerifyMfaInput
} from '../../security/security.service';

@Injectable()
export class V2ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly securityService: SecurityService
  ) {}

  async bootstrap(
    user: AuthenticatedUser,
    currentSessionIdentifier: string | undefined,
    sessionQuery: ListSessionsQuery
  ) {
    const [profile, mfaStatus, sessions] = await Promise.all([
      this.getProfile(user.id),
      this.securityService.getMyMfaStatus(user),
      this.securityService.listUserActiveSessions(
        user.id,
        { ...sessionQuery, revoked: 'false' },
        currentSessionIdentifier
      )
    ]);

    return {
      profile,
      mfaStatus,
      sessions,
      generatedAt: new Date().toISOString()
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        status: 'active',
        deletedAt: null
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        phoneMasked: true,
        status: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        v2AuthIdentity: {
          select: {
            mustResetPassword: true,
            lastAuthenticatedAt: true
          }
        },
        userRoles: {
          select: {
            role: {
              select: {
                code: true,
                name: true
              }
            }
          }
        }
      }
    });
    if (!user) throw new NotFoundException('登录账号不存在或已停用。');

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      emailMasked: this.maskEmail(user.email),
      phoneMasked: user.phoneMasked,
      status: user.status,
      roles: user.userRoles.map(({ role }) => role),
      mustResetPassword: user.v2AuthIdentity?.mustResetPassword ?? false,
      lastAuthenticatedAt: user.v2AuthIdentity?.lastAuthenticatedAt?.toISOString() ?? null,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString()
    };
  }

  listSessions(
    user: AuthenticatedUser,
    currentSessionIdentifier: string | undefined,
    query: ListSessionsQuery
  ) {
    return this.securityService.listUserActiveSessions(
      user.id,
      { ...query, revoked: 'false' },
      currentSessionIdentifier
    );
  }

  revokeSession(id: string, user: AuthenticatedUser, currentSessionIdentifier: string | undefined) {
    return this.securityService.revokeOwnSession(id, user, currentSessionIdentifier);
  }

  async revokeOtherSessions(user: AuthenticatedUser, currentSessionIdentifier: string | undefined) {
    const revokedCount = await this.securityService.revokeOtherSessions(
      user.id,
      currentSessionIdentifier,
      user
    );
    return { revokedCount };
  }

  getMfaStatus(user: AuthenticatedUser) {
    return this.securityService.getMyMfaStatus(user);
  }

  setupMfa(user: AuthenticatedUser) {
    return this.securityService.setupMyMfa(user);
  }

  enableMfa(user: AuthenticatedUser, input: VerifyMfaInput) {
    return this.securityService.enableMyMfa(user, input);
  }

  regenerateMfaRecoveryCodes(user: AuthenticatedUser, input: VerifyMfaInput) {
    return this.securityService.regenerateMyMfaRecoveryCodes(user, input);
  }

  disableMfa(user: AuthenticatedUser, input: DisableMfaInput) {
    return this.securityService.disableMyMfa(user, input);
  }

  private maskEmail(value: string | null) {
    if (!value) return null;
    const separator = value.lastIndexOf('@');
    if (separator <= 0 || separator === value.length - 1) return '***';
    return `${value.slice(0, 1)}***@${value.slice(separator + 1)}`;
  }
}
