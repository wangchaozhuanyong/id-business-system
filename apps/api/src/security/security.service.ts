import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ActiveSession,
  IpWhitelist,
  IpWhitelistScope,
  LoginLog,
  LoginLogStatus,
  Prisma,
  SecuritySetting,
  SensitiveAccessApproval,
  SensitiveAccessApprovalStatus,
  SensitiveAccessLog
} from '@prisma/client';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { TimedMemoryCache } from '../common/cache/timed-memory-cache';
import { FieldEncryptionService } from '../common/crypto/field-encryption.service';
import { getPagination, type PaginationQuery } from '../common/pagination';
import { PrismaService } from '../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../common/prisma/mysql-transaction-lock';

const ACTIVE_SESSION_TOUCH_INTERVAL_MS = 60_000;
const ACTIVE_TOKEN_CACHE_TTL_MS = 15_000;
const IP_WHITELIST_CACHE_TTL_MS = 30_000;
const SECURITY_OVERVIEW_CACHE_TTL_MS = 120_000;

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

interface ListLoginLogsQuery extends PaginationQuery {
  keyword?: string;
  status?: string;
  abnormal?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListSessionsQuery extends PaginationQuery {
  keyword?: string;
  revoked?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface ListIpWhitelistsQuery extends PaginationQuery {
  keyword?: string;
  scope?: string;
  enabled?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface ListMfaUsersQuery extends PaginationQuery {
  keyword?: string;
}

interface ListSensitiveAccessLogsQuery extends PaginationQuery {
  keyword?: string;
  module?: string;
  fieldName?: string;
  approved?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface ListSensitiveApprovalsQuery extends PaginationQuery {
  keyword?: string;
  status?: string;
  module?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface RecordLoginAttemptInput extends RequestMeta {
  userId?: string | null;
  username: string;
  status: LoginLogStatus;
  failureReason?: string | null;
  abnormal?: boolean;
}

export interface ReserveLoginAttemptInput extends RequestMeta {
  username: string;
}

export type ReserveLoginAttemptResult =
  | { allowed: true; reservationId: string }
  | { allowed: false; retryAfterMs: number };

export interface FinalizeLoginAttemptInput {
  userId?: string | null;
  status: LoginLogStatus;
  failureReason?: string | null;
  abnormal?: boolean;
}

export interface CreateActiveSessionInput extends RequestMeta {
  userId: string;
  accessToken: string;
  expiresAt: Date;
}

export interface EnsureActiveSessionInput extends RequestMeta {
  userId: string;
  sessionIdentifier: string;
  expiresAt: Date;
}

export interface SaveIpWhitelistInput {
  ipOrCidr?: string;
  scope?: string;
  enabled?: boolean;
  remark?: string | null;
}

export interface CreateSensitiveApprovalInput {
  module?: string;
  fieldName?: string;
  objectType?: string;
  objectId?: string | null;
  reason?: string;
  expiresAt?: string | null;
}

export interface DecideSensitiveApprovalInput {
  decisionNote?: string | null;
  expiresAt?: string | null;
}

export interface VerifyMfaInput {
  code?: string | null;
}

export interface DisableMfaInput extends VerifyMfaInput {
  reason?: string | null;
}

export interface UpdateMfaSettingsInput {
  enabled?: boolean;
  requiredForAdmins?: boolean;
  issuer?: string;
}

export interface MfaLoginRequirement {
  required: boolean;
  bound: boolean;
  reason: 'bound_user' | 'admin_required' | null;
}

const LOGIN_LOG_SORT_FIELDS: Record<string, keyof Prisma.LoginLogOrderByWithRelationInput> = {
  createdAt: 'createdAt',
  username: 'username',
  status: 'status',
  abnormal: 'abnormal',
  ip: 'ip',
  failureReason: 'failureReason'
};

const IP_WHITELIST_SORT_FIELDS: Record<string, keyof Prisma.IpWhitelistOrderByWithRelationInput> = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  ipOrCidr: 'ipOrCidr',
  scope: 'scope',
  enabled: 'enabled',
  remark: 'remark'
};

const ACTIVE_SESSION_SORT_FIELDS: Record<
  string,
  keyof Prisma.ActiveSessionOrderByWithRelationInput
> = {
  createdAt: 'createdAt',
  lastActiveAt: 'lastActiveAt',
  expiresAt: 'expiresAt',
  revokedAt: 'revokedAt',
  ip: 'ip',
  userAgent: 'userAgent'
};

const SENSITIVE_ACCESS_LOG_SORT_FIELDS: Record<
  string,
  keyof Prisma.SensitiveAccessLogOrderByWithRelationInput
> = {
  createdAt: 'createdAt',
  module: 'module',
  fieldName: 'fieldName',
  objectType: 'objectType',
  approved: 'approved',
  ip: 'ip'
};

const SENSITIVE_APPROVAL_SORT_FIELDS: Record<
  string,
  keyof Prisma.SensitiveAccessApprovalOrderByWithRelationInput
> = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  module: 'module',
  fieldName: 'fieldName',
  objectType: 'objectType',
  status: 'status',
  approvedAt: 'approvedAt',
  expiresAt: 'expiresAt'
};

const LOGIN_FAILURE_WINDOW_MINUTES = 15;
const LOGIN_FAILURE_THRESHOLD = 5;
const LOGIN_FAILURE_STATUSES: LoginLogStatus[] = ['failed', 'blocked'];
const MFA_TOTP_PERIOD_SECONDS = 30;
const MFA_TOTP_DIGITS = 6;
const MFA_TOTP_WINDOW = 1;
const MFA_RECOVERY_CODE_COUNT = 10;
const MFA_RECOVERY_CODE_BYTES = 5;
const MFA_BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

interface LoginRiskContext {
  continuousFailure?: boolean;
  failureCount?: number;
  threshold?: number;
  windowMinutes?: number;
}

interface UserMfaState {
  enabled?: boolean;
  secretEncrypted?: string | null;
  recoveryCodeHashes?: string[];
  recoveryCodeCount?: number;
  createdAt?: string;
  enabledAt?: string | null;
  lastUsedAt?: string | null;
  lastUsedCounter?: number | null;
  disabledAt?: string | null;
  disabledReason?: string | null;
}

type MfaStateClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'securitySetting'>;

interface ConsumedMfaCode {
  method: 'totp' | 'recovery_code';
  state: UserMfaState;
}

interface SecurityOverviewCounts {
  failedLoginCount: number;
  abnormalLoginCount: number;
  activeSessionCount: number;
  pendingApprovalCount: number;
  enabledWhitelistCount: number;
}

interface SecurityOverviewCountsRow {
  failedLoginCount: bigint | number | string | null;
  abnormalLoginCount: bigint | number | string | null;
  activeSessionCount: bigint | number | string | null;
  pendingApprovalCount: bigint | number | string | null;
  enabledWhitelistCount: bigint | number | string | null;
}

@Injectable()
export class SecurityService {
  private readonly activeTokenCache = new TimedMemoryCache();
  private readonly ipWhitelistCache = new TimedMemoryCache();
  private readonly overviewCache = new TimedMemoryCache();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
    private readonly fieldEncryptionService: FieldEncryptionService
  ) {}

  async overview() {
    return this.overviewCache.getOrSet('overview', SECURITY_OVERVIEW_CACHE_TTL_MS, async () => {
      const now = new Date();
      const [counts, recentLoginLogs] = await Promise.all([
        this.getSecurityOverviewCounts(now),
        this.prisma.loginLog.findMany({
          take: 8,
          orderBy: { createdAt: 'desc' },
          include: this.getLoginLogInclude()
        })
      ]);

      return {
        ...counts,
        recentLoginLogs: recentLoginLogs.map((item) => this.toLoginLogResponse(item))
      };
    });
  }

  private async getSecurityOverviewCounts(now: Date): Promise<SecurityOverviewCounts> {
    if (typeof this.prisma.$queryRaw !== 'function') {
      return this.getSecurityOverviewCountsWithPrisma(now);
    }

    try {
      const rows = await this.prisma.$queryRaw<SecurityOverviewCountsRow[]>`
        SELECT
          (SELECT COUNT(*) FROM login_logs WHERE status = 'failed') AS "failedLoginCount",
          (SELECT COUNT(*) FROM login_logs WHERE abnormal = true) AS "abnormalLoginCount",
          (
            SELECT COUNT(*)
            FROM active_sessions
            WHERE revoked_at IS NULL AND expires_at > ${now}
          ) AS "activeSessionCount",
          (
            SELECT COUNT(*)
            FROM sensitive_access_approvals
            WHERE status = 'pending'
          ) AS "pendingApprovalCount",
          (SELECT COUNT(*) FROM ip_whitelists WHERE enabled = true) AS "enabledWhitelistCount"
      `;
      const row = rows[0];
      if (!row) throw new Error('Missing security overview counts row');
      return {
        failedLoginCount: this.getCountNumber(row.failedLoginCount),
        abnormalLoginCount: this.getCountNumber(row.abnormalLoginCount),
        activeSessionCount: this.getCountNumber(row.activeSessionCount),
        pendingApprovalCount: this.getCountNumber(row.pendingApprovalCount),
        enabledWhitelistCount: this.getCountNumber(row.enabledWhitelistCount)
      };
    } catch {
      return this.getSecurityOverviewCountsWithPrisma(now);
    }
  }

  private async getSecurityOverviewCountsWithPrisma(now: Date): Promise<SecurityOverviewCounts> {
    const [
      failedLoginCount,
      abnormalLoginCount,
      activeSessionCount,
      pendingApprovalCount,
      enabledWhitelistCount
    ] = await Promise.all([
      this.prisma.loginLog.count({ where: { status: 'failed' } }),
      this.prisma.loginLog.count({ where: { abnormal: true } }),
      this.prisma.activeSession.count({
        where: {
          revokedAt: null,
          expiresAt: { gt: now }
        }
      }),
      this.prisma.sensitiveAccessApproval.count({ where: { status: 'pending' } }),
      this.prisma.ipWhitelist.count({ where: { enabled: true } })
    ]);

    return {
      failedLoginCount,
      abnormalLoginCount,
      activeSessionCount,
      pendingApprovalCount,
      enabledWhitelistCount
    };
  }

  async recordLoginAttempt(input: RecordLoginAttemptInput) {
    const username = this.normalizeRequiredString(input.username, 'username');
    const status = this.parseLoginStatus(input.status, true);
    const failureReason = this.normalizeNullableString(input.failureReason);
    const ip = this.normalizeNullableString(input.ip);
    const userAgent = this.normalizeNullableString(input.userAgent);
    const riskContext = LOGIN_FAILURE_STATUSES.includes(status)
      ? await this.getLoginFailureRiskContext(username, ip)
      : undefined;
    const abnormal = Boolean(input.abnormal) || Boolean(riskContext?.continuousFailure);
    const log = await this.prisma.loginLog.create({
      data: {
        userId: input.userId ?? undefined,
        username,
        status,
        failureReason,
        ip,
        userAgent,
        abnormal
      }
    });

    if (status !== 'success' || abnormal) {
      this.overviewCache.clear();
    }
    return this.toLoginLogResponse(log);
  }

  async reserveLoginAttempt(input: ReserveLoginAttemptInput): Promise<ReserveLoginAttemptResult> {
    const username = this.normalizeRequiredString(input.username, 'username');
    const usernameKey = username.toLocaleLowerCase('en-US');
    const ip = this.normalizeNullableString(input.ip);
    const userAgent = this.normalizeNullableString(input.userAgent);
    const windowStart = new Date(Date.now() - LOGIN_FAILURE_WINDOW_MINUTES * 60 * 1000);

    return this.prisma.$transaction(async (client) => {
      const lockKeys = [`security:login:username:${usernameKey}`];
      if (ip) lockKeys.push(`security:login:ip:${ip}`);
      for (const key of lockKeys.sort()) {
        await acquireMysqlTransactionLock(client, key);
      }

      const policy = await client.securitySetting.findUnique({ where: { key: 'password_policy' } });
      const threshold = this.getPositiveIntegerSetting(
        ((policy?.value ?? {}) as Record<string, unknown>).maxFailedAttempts,
        LOGIN_FAILURE_THRESHOLD
      );
      const baseWhere: Prisma.LoginLogWhereInput = {
        status: { in: LOGIN_FAILURE_STATUSES },
        failureReason: { not: 'authentication_unavailable' },
        createdAt: { gte: windowStart }
      };
      const countQueries = [
        client.loginLog.count({
          where: {
            ...baseWhere,
            username: { equals: username }
          }
        })
      ];
      if (ip) {
        countQueries.push(client.loginLog.count({ where: { ...baseWhere, ip } }));
      }
      const [usernameFailures = 0, ipFailures = 0] = await Promise.all(countQueries);
      if (Math.max(usernameFailures, ipFailures) >= threshold) {
        return {
          allowed: false as const,
          retryAfterMs: LOGIN_FAILURE_WINDOW_MINUTES * 60 * 1000
        };
      }

      const reservation = await client.loginLog.create({
        data: {
          username,
          status: 'blocked',
          failureReason: 'authentication_in_progress',
          ip,
          userAgent,
          abnormal: false
        },
        select: { id: true }
      });
      return { allowed: true as const, reservationId: reservation.id };
    });
  }

  async finalizeLoginAttempt(reservationIdInput: string, input: FinalizeLoginAttemptInput) {
    const reservationId = this.normalizeRequiredUuid(reservationIdInput, 'reservationId');
    const result = await this.prisma.loginLog.updateMany({
      where: {
        id: reservationId,
        failureReason: 'authentication_in_progress'
      },
      data: {
        userId: input.userId ?? undefined,
        status: this.parseLoginStatus(input.status, true),
        failureReason: this.normalizeNullableString(input.failureReason),
        abnormal: Boolean(input.abnormal)
      }
    });
    if (result.count > 0) this.overviewCache.clear();
    return result.count === 1;
  }

  async createActiveSession(input: CreateActiveSessionInput) {
    return this.createProviderActiveSession({
      userId: input.userId,
      sessionIdentifier: input.accessToken,
      expiresAt: input.expiresAt,
      ip: input.ip,
      userAgent: input.userAgent
    });
  }

  async ensureActiveSession(input: EnsureActiveSessionInput) {
    const userId = this.normalizeRequiredUuid(input.userId, 'userId');
    const sessionIdentifier = this.normalizeRequiredString(
      input.sessionIdentifier,
      'sessionIdentifier'
    );
    const tokenHash = this.hashToken(sessionIdentifier);
    const now = new Date();
    if (
      !(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt <= now
    ) {
      this.activeTokenCache.delete(tokenHash);
      return false;
    }
    const session = await this.prisma.activeSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        revokedAt: true,
        expiresAt: true,
        lastActiveAt: true
      }
    });

    if (!session || session.userId !== userId || session.revokedAt || session.expiresAt <= now) {
      this.activeTokenCache.delete(tokenHash);
      return false;
    }

    const shouldTouch =
      now.getTime() - session.lastActiveAt.getTime() >= ACTIVE_SESSION_TOUCH_INTERVAL_MS;
    const shouldExtend = input.expiresAt.getTime() > session.expiresAt.getTime();
    if (shouldTouch || shouldExtend) {
      const touchCutoff = new Date(now.getTime() - ACTIVE_SESSION_TOUCH_INTERVAL_MS);
      const result = await this.prisma.activeSession.updateMany({
        where: {
          id: session.id,
          userId,
          tokenHash,
          revokedAt: null,
          expiresAt: { gt: now },
          ...(shouldTouch && !shouldExtend ? { lastActiveAt: { lte: touchCutoff } } : {})
        },
        data: {
          ...(shouldTouch ? { lastActiveAt: now } : {}),
          ...(shouldExtend ? { expiresAt: input.expiresAt } : {})
        }
      });
      if (result.count !== 1) {
        const current = await this.prisma.activeSession.findUnique({
          where: { tokenHash },
          select: { userId: true, revokedAt: true, expiresAt: true }
        });
        if (
          !current ||
          current.userId !== userId ||
          current.revokedAt ||
          current.expiresAt <= now
        ) {
          this.activeTokenCache.delete(tokenHash);
          return false;
        }
      }
    }

    this.cacheActiveToken(tokenHash, input.expiresAt, now);
    return true;
  }

  async createProviderActiveSession(input: EnsureActiveSessionInput) {
    const sessionIdentifier = this.normalizeRequiredString(
      input.sessionIdentifier,
      'sessionIdentifier'
    );
    const tokenHash = this.hashToken(sessionIdentifier);
    if (
      !(input.expiresAt instanceof Date) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt <= new Date()
    ) {
      throw new BadRequestException('expiresAt is invalid');
    }
    const session = await this.prisma.activeSession.create({
      data: {
        userId: this.normalizeRequiredUuid(input.userId, 'userId'),
        tokenHash,
        ip: this.normalizeNullableString(input.ip),
        userAgent: this.normalizeNullableString(input.userAgent),
        expiresAt: input.expiresAt
      },
      include: this.getSessionInclude()
    });

    this.cacheActiveToken(tokenHash, input.expiresAt);
    return this.toSessionResponse(session);
  }

  async isAccessTokenActive(accessToken: string | null | undefined) {
    if (!accessToken) {
      return false;
    }

    const now = new Date();
    const tokenHash = this.hashToken(accessToken);
    const session = await this.prisma.activeSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        revokedAt: true,
        expiresAt: true,
        lastActiveAt: true
      }
    });

    if (!session || session.revokedAt || session.expiresAt <= now) {
      this.activeTokenCache.delete(tokenHash);
      return false;
    }

    if (now.getTime() - session.lastActiveAt.getTime() >= ACTIVE_SESSION_TOUCH_INTERVAL_MS) {
      await this.prisma.activeSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: now }
        },
        data: {
          lastActiveAt: now
        }
      });
    }

    return true;
  }

  async revokeAccessToken(accessToken: string | null | undefined, operator?: AuthenticatedUser) {
    return this.revokeSessionIdentifier(accessToken, operator);
  }

  async revokeSessionIdentifier(
    sessionIdentifier: string | null | undefined,
    operator?: AuthenticatedUser
  ) {
    if (!sessionIdentifier) {
      return false;
    }

    const session = await this.prisma.activeSession.findUnique({
      where: { tokenHash: this.hashToken(sessionIdentifier) },
      include: this.getSessionInclude()
    });

    if (!session || session.revokedAt) {
      return false;
    }

    const updated = await this.prisma.activeSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
      include: this.getSessionInclude()
    });

    this.activeTokenCache.delete(session.tokenHash);
    this.overviewCache.clear();
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'security',
      action: 'security.session.logout',
      objectType: 'active_session',
      objectId: session.id,
      afterData: this.toAuditJson({
        sessionId: session.id,
        userId: session.userId,
        username: session.user.username
      }),
      remark: `Logged out active session ${session.id}`
    });

    return Boolean(updated.revokedAt);
  }

  async revokeOtherSessions(
    userIdInput: string,
    currentSessionIdentifier: string | null | undefined,
    operator?: AuthenticatedUser
  ) {
    const userId = this.normalizeRequiredUuid(userIdInput, 'userId');
    const currentTokenHash = currentSessionIdentifier
      ? this.hashToken(currentSessionIdentifier)
      : undefined;
    const revokedAt = new Date();
    const result = await this.prisma.activeSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(currentTokenHash ? { tokenHash: { not: currentTokenHash } } : {})
      },
      data: {
        revokedAt
      }
    });

    this.activeTokenCache.clear();
    this.overviewCache.clear();
    if (result.count > 0) {
      await this.auditLogsService.create({
        userId: operator?.id,
        module: 'security',
        action: 'security.session.revoke_others',
        objectType: 'user',
        objectId: userId,
        afterData: this.toAuditJson({
          userId,
          revokedSessionCount: result.count
        }),
        remark: `Revoked ${result.count} other active sessions`
      });
    }
    return result.count;
  }

  invalidateActiveSessionCache() {
    this.activeTokenCache.clear();
  }

  async isRequestIpAllowed(ip: string | null | undefined, scopes: IpWhitelistScope[]) {
    const records = await this.ipWhitelistCache.getOrSet(
      this.getIpWhitelistCacheKey(scopes),
      IP_WHITELIST_CACHE_TTL_MS,
      () =>
        this.prisma.ipWhitelist.findMany({
          where: {
            enabled: true,
            scope: {
              in: scopes
            }
          },
          select: {
            ipOrCidr: true
          }
        })
    );

    if (!records.length) {
      return true;
    }

    const normalizedIp = this.normalizeRequestIp(ip);
    if (!normalizedIp) {
      return false;
    }

    return records.some((record) => this.matchesIpOrCidr(normalizedIp, record.ipOrCidr));
  }

  async listLoginLogs(query: ListLoginLogsQuery) {
    const pagination = getPagination(query);
    const keyword = query.keyword?.trim();
    const status = this.parseLoginStatus(query.status, false);
    const abnormal = this.parseBoolean(query.abnormal);
    const where: Prisma.LoginLogWhereInput = {
      status: status ?? undefined,
      abnormal,
      OR: keyword
        ? [
            { username: { contains: keyword } },
            { ip: { contains: keyword } },
            { failureReason: { contains: keyword } }
          ]
        : undefined
    };

    const [items, total] = await Promise.all([
      this.prisma.loginLog.findMany({
        where,
        include: this.getLoginLogInclude(),
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildLoginLogOrderBy(query)
      }),
      this.prisma.loginLog.count({ where })
    ]);

    return {
      items: items.map((item) => this.toLoginLogResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  listAbnormalLogins(query: ListLoginLogsQuery) {
    return this.listLoginLogs({ ...query, abnormal: 'true' });
  }

  private buildLoginLogOrderBy(
    query: ListLoginLogsQuery
  ): Prisma.LoginLogOrderByWithRelationInput[] {
    const sortField = query.sortBy ? LOGIN_LOG_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder = this.parseSortOrder(query.sortOrder);

    if (!sortField || !sortOrder) {
      return [{ createdAt: 'desc' }];
    }

    return [{ [sortField]: sortOrder }, { createdAt: 'desc' }];
  }

  listActiveSessions(query: ListSessionsQuery, currentSessionIdentifier?: string | null) {
    return this.listActiveSessionsInternal(query, currentSessionIdentifier);
  }

  listUserActiveSessions(
    userId: string,
    query: ListSessionsQuery,
    currentSessionIdentifier?: string | null
  ) {
    return this.listActiveSessionsInternal(
      query,
      currentSessionIdentifier,
      this.normalizeRequiredUuid(userId, 'userId')
    );
  }

  private async listActiveSessionsInternal(
    query: ListSessionsQuery,
    currentSessionIdentifier?: string | null,
    userId?: string
  ) {
    const pagination = getPagination(query);
    const keyword = query.keyword?.trim();
    const revoked = this.parseBoolean(query.revoked);
    const where: Prisma.ActiveSessionWhereInput = {
      userId,
      revokedAt: revoked === undefined ? undefined : revoked ? { not: null } : null,
      OR: keyword
        ? [
            { ip: { contains: keyword } },
            { userAgent: { contains: keyword } },
            { user: { is: { username: { contains: keyword } } } },
            { user: { is: { displayName: { contains: keyword } } } }
          ]
        : undefined
    };

    const [items, total] = await Promise.all([
      this.prisma.activeSession.findMany({
        where,
        include: this.getSessionInclude(),
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildSessionOrderBy(query)
      }),
      this.prisma.activeSession.count({ where })
    ]);

    const currentTokenHash = currentSessionIdentifier
      ? this.hashToken(currentSessionIdentifier)
      : undefined;

    return {
      items: items.map((item) => ({
        ...this.toSessionResponse(item),
        isCurrent: Boolean(currentTokenHash && item.tokenHash === currentTokenHash)
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  private buildSessionOrderBy(
    query: ListSessionsQuery
  ): Prisma.ActiveSessionOrderByWithRelationInput[] {
    const sortField = query.sortBy ? ACTIVE_SESSION_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder = this.parseSortOrder(query.sortOrder);

    if (!sortField || !sortOrder) {
      return [{ lastActiveAt: 'desc' }];
    }

    return [{ [sortField]: sortOrder }, { lastActiveAt: 'desc' }];
  }

  async revokeSession(id: string, operator?: AuthenticatedUser) {
    const sessionId = this.normalizeRequiredUuid(id, 'id');
    const session = await this.prisma.activeSession.findUnique({
      where: { id: sessionId },
      include: this.getSessionInclude()
    });

    if (!session) {
      throw new NotFoundException('Active session not found');
    }

    const updated = await this.prisma.activeSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
      include: this.getSessionInclude()
    });

    this.activeTokenCache.delete(session.tokenHash);
    this.overviewCache.clear();
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'security',
      action: 'security.session.revoke',
      objectType: 'active_session',
      objectId: session.id,
      afterData: this.toAuditJson({
        sessionId: session.id,
        userId: session.userId,
        username: session.user.username
      }),
      remark: `Revoked active session ${session.id}`
    });

    return this.toSessionResponse(updated);
  }

  async revokeOwnSession(
    id: string,
    user: AuthenticatedUser,
    currentSessionIdentifier?: string | null
  ) {
    const sessionId = this.normalizeRequiredUuid(id, 'id');
    const session = await this.prisma.activeSession.findUnique({
      where: { id: sessionId },
      include: this.getSessionInclude()
    });
    if (!session || session.userId !== user.id) {
      throw new NotFoundException('Active session not found');
    }

    const currentTokenHash = currentSessionIdentifier
      ? this.hashToken(currentSessionIdentifier)
      : undefined;
    if (currentTokenHash && session.tokenHash === currentTokenHash) {
      throw new BadRequestException('当前会话请使用退出登录操作。');
    }
    if (session.revokedAt) {
      return this.toSessionResponse(session);
    }

    return this.revokeSession(session.id, user);
  }

  getMfaSettings() {
    return this.getSetting('mfa_settings', {
      enabled: false,
      requiredForAdmins: false,
      issuer: '代充管理后台',
      recoveryCodeCount: MFA_RECOVERY_CODE_COUNT
    });
  }

  updateMfaSettings(value: Record<string, unknown>, operator?: AuthenticatedUser) {
    return this.upsertSetting('mfa_settings', value, 'MFA 设置', operator);
  }

  async updateMfaSettingsSafely(input: UpdateMfaSettingsInput, operator: AuthenticatedUser) {
    if (typeof input.enabled !== 'boolean' || typeof input.requiredForAdmins !== 'boolean') {
      throw new BadRequestException('MFA 策略启用状态必须明确填写。');
    }
    if (!input.enabled && input.requiredForAdmins) {
      throw new BadRequestException('启用 MFA 后才能要求管理员强制使用。');
    }
    const issuer = this.normalizeRequiredString(input.issuer, 'issuer');
    if (issuer.length > 80) {
      throw new BadRequestException('MFA 签发方不能超过 80 个字符。');
    }

    if (input.enabled && input.requiredForAdmins) {
      const unboundAdmins = await this.findUnboundActiveAdmins();
      if (unboundAdmins.length) {
        throw new BadRequestException(
          `仍有 ${unboundAdmins.length} 个启用管理员未绑定 MFA，不能开启强制策略。`
        );
      }
    }

    return this.updateMfaSettings(
      {
        enabled: input.enabled,
        requiredForAdmins: input.requiredForAdmins,
        issuer,
        recoveryCodeCount: MFA_RECOVERY_CODE_COUNT
      },
      operator
    );
  }

  async listMfaUsers(query: ListMfaUsersQuery) {
    const pagination = getPagination(query);
    const keyword = query.keyword?.trim();
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      OR: keyword
        ? [{ username: { contains: keyword } }, { displayName: { contains: keyword } }]
        : undefined
    };
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: [{ status: 'asc' }, { username: 'asc' }],
        select: {
          id: true,
          username: true,
          displayName: true,
          status: true,
          userRoles: {
            select: {
              role: { select: { code: true } }
            }
          }
        }
      }),
      this.prisma.user.count({ where })
    ]);
    const settings = await this.prisma.securitySetting.findMany({
      where: {
        key: { in: users.map((user) => this.getUserMfaSettingKey(user.id)) }
      },
      select: { key: true, value: true }
    });
    const settingsByKey = new Map(settings.map((setting) => [setting.key, setting.value]));

    return {
      items: users.map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        status: user.status,
        roles: user.userRoles.map(({ role }) => role.code),
        ...this.toMfaStatusResponse(
          this.parseUserMfaState(settingsByKey.get(this.getUserMfaSettingKey(user.id)))
        )
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async getMyMfaStatus(user: AuthenticatedUser) {
    const state = await this.getUserMfaState(user.id);
    return this.toMfaStatusResponse(state);
  }

  async setupMyMfa(user: AuthenticatedUser) {
    const secret = this.generateBase32Secret();
    const settings = await this.getMfaSettings();
    const issuer = this.getMfaIssuer(settings.value);
    const state = await this.withLockedUserMfaState(user.id, (current, client) => {
      if (current.enabled) {
        throw new BadRequestException('MFA 已启用，如需重新绑定请先按安全流程停用。');
      }
      return this.saveUserMfaState(
        user.id,
        {
          enabled: false,
          secretEncrypted: this.fieldEncryptionService.encrypt(secret),
          recoveryCodeHashes: [],
          recoveryCodeCount: 0,
          createdAt: new Date().toISOString(),
          enabledAt: null,
          lastUsedAt: null,
          lastUsedCounter: null,
          disabledAt: null,
          disabledReason: null
        },
        client
      );
    });

    await this.auditLogsService.create({
      userId: user.id,
      module: 'security',
      action: 'security.mfa.setup',
      objectType: 'user_mfa',
      objectId: user.id,
      afterData: this.toAuditJson(this.toMfaStatusResponse(state)),
      remark: `Prepared MFA setup for ${user.username}`
    });

    return {
      ...this.toMfaStatusResponse(state),
      secret,
      otpauthUrl: this.buildOtpAuthUrl({
        issuer,
        accountName: user.username,
        secret
      })
    };
  }

  async enableMyMfa(user: AuthenticatedUser, dto: VerifyMfaInput) {
    const code = this.normalizeMfaCode(dto.code);
    const recoveryCodes = this.generateRecoveryCodes();
    const updated = await this.withLockedUserMfaState(user.id, (state, client) => {
      if (state.enabled) throw new BadRequestException('MFA 已启用。');
      const secret = this.getMfaSecretOrThrow(state);
      const verification = this.verifyTotp(secret, code);
      if (!verification.valid) {
        throw new BadRequestException('动态验证码或恢复码错误，请重新输入。');
      }
      return this.saveUserMfaState(
        user.id,
        {
          ...state,
          enabled: true,
          recoveryCodeHashes: recoveryCodes.map((item) => this.hashRecoveryCode(user.id, item)),
          recoveryCodeCount: recoveryCodes.length,
          enabledAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          lastUsedCounter: verification.counter,
          disabledAt: null,
          disabledReason: null
        },
        client
      );
    });

    await this.auditLogsService.create({
      userId: user.id,
      module: 'security',
      action: 'security.mfa.enable',
      objectType: 'user_mfa',
      objectId: user.id,
      afterData: this.toAuditJson(this.toMfaStatusResponse(updated)),
      remark: `Enabled MFA for ${user.username}`
    });

    return {
      ...this.toMfaStatusResponse(updated),
      recoveryCodes
    };
  }

  async regenerateMyMfaRecoveryCodes(user: AuthenticatedUser, dto: VerifyMfaInput) {
    const code = this.normalizeMfaCode(dto.code);
    const recoveryCodes = this.generateRecoveryCodes();
    const updated = await this.withLockedUserMfaState(user.id, async (state, client) => {
      this.assertEnabledUserMfaState(state);
      const consumed = this.consumeMfaCode(user.id, code, state);
      return this.saveUserMfaState(
        user.id,
        {
          ...consumed.state,
          recoveryCodeHashes: recoveryCodes.map((item) => this.hashRecoveryCode(user.id, item)),
          recoveryCodeCount: recoveryCodes.length
        },
        client
      );
    });

    await this.auditLogsService.create({
      userId: user.id,
      module: 'security',
      action: 'security.mfa.recovery_codes.regenerate',
      objectType: 'user_mfa',
      objectId: user.id,
      afterData: this.toAuditJson(this.toMfaStatusResponse(updated)),
      remark: `Regenerated MFA recovery codes for ${user.username}`
    });

    return {
      ...this.toMfaStatusResponse(updated),
      recoveryCodes
    };
  }

  async disableMyMfa(user: AuthenticatedUser, dto: DisableMfaInput) {
    const settings = await this.getMfaSettings();
    const settingsValue = settings.value as Record<string, unknown>;
    if (
      this.isAdminUser(user) &&
      this.getSettingBoolean(settingsValue.enabled, false) &&
      this.getSettingBoolean(settingsValue.requiredForAdmins, false)
    ) {
      throw new BadRequestException('管理员强制 MFA 已启用，不能停用当前绑定。');
    }
    const code = this.normalizeMfaCode(dto.code);
    const updated = await this.withLockedUserMfaState(user.id, (state, client) => {
      this.assertEnabledUserMfaState(state);
      const consumed = this.consumeMfaCode(user.id, code, state);
      return this.saveUserMfaState(
        user.id,
        {
          ...consumed.state,
          enabled: false,
          recoveryCodeHashes: [],
          recoveryCodeCount: 0,
          disabledAt: new Date().toISOString(),
          disabledReason: this.normalizeNullableString(dto.reason)
        },
        client
      );
    });

    await this.auditLogsService.create({
      userId: user.id,
      module: 'security',
      action: 'security.mfa.disable',
      objectType: 'user_mfa',
      objectId: user.id,
      afterData: this.toAuditJson(this.toMfaStatusResponse(updated)),
      remark: `Disabled MFA for ${user.username}`
    });

    return this.toMfaStatusResponse(updated);
  }

  async resetUserMfa(userId: string, operator?: AuthenticatedUser) {
    const normalizedUserId = this.normalizeRequiredUuid(userId, 'userId');
    const updated = await this.withLockedUserMfaState(normalizedUserId, (_state, client) => {
      return this.saveUserMfaState(
        normalizedUserId,
        {
          enabled: false,
          secretEncrypted: null,
          recoveryCodeHashes: [],
          recoveryCodeCount: 0,
          disabledAt: new Date().toISOString(),
          disabledReason: 'admin_reset'
        },
        client
      );
    });

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'security',
      action: 'security.mfa.admin_reset',
      objectType: 'user_mfa',
      objectId: normalizedUserId,
      afterData: this.toAuditJson(this.toMfaStatusResponse(updated)),
      remark: `Reset MFA for user ${normalizedUserId}`
    });

    return this.toMfaStatusResponse(updated);
  }

  async resetUserMfaSafely(userId: string, operator: AuthenticatedUser) {
    const normalizedUserId = this.normalizeRequiredUuid(userId, 'userId');
    const target = await this.prisma.user.findUnique({
      where: { id: normalizedUserId },
      select: {
        status: true,
        userRoles: {
          select: { role: { select: { code: true } } }
        }
      }
    });
    if (!target) throw new NotFoundException('User not found');

    const settings = await this.getMfaSettings();
    const value = settings.value as Record<string, unknown>;
    const isProtectedAdmin =
      target.status === 'active' &&
      target.userRoles.some(({ role }) => role.code === 'admin') &&
      this.getSettingBoolean(value.enabled, false) &&
      this.getSettingBoolean(value.requiredForAdmins, false);
    if (isProtectedAdmin) {
      throw new BadRequestException('管理员强制 MFA 已启用，不能重置启用管理员的绑定。');
    }

    return this.resetUserMfa(normalizedUserId, operator);
  }

  async getMfaLoginRequirementForUser(user: AuthenticatedUser): Promise<MfaLoginRequirement> {
    const [settings, state] = await Promise.all([
      this.getMfaSettings(),
      this.getUserMfaState(user.id)
    ]);
    const userMfaBound = Boolean(state.enabled && state.secretEncrypted);
    if (userMfaBound) {
      return {
        required: true,
        bound: true,
        reason: 'bound_user'
      };
    }

    const settingsValue = settings.value as Record<string, unknown>;
    const globalMfaEnabled = this.getSettingBoolean(settingsValue.enabled, false);
    const adminMfaRequired = this.getSettingBoolean(settingsValue.requiredForAdmins, false);
    if (globalMfaEnabled && adminMfaRequired && this.isAdminUser(user)) {
      return {
        required: true,
        bound: false,
        reason: 'admin_required'
      };
    }

    return {
      required: false,
      bound: false,
      reason: null
    };
  }

  async isMfaRequiredForUser(user: AuthenticatedUser) {
    const requirement = await this.getMfaLoginRequirementForUser(user);
    return requirement.required;
  }

  async verifyUserMfaCode(userId: string, code: string | null | undefined) {
    const normalizedCode = this.normalizeMfaCode(code);
    return this.withLockedUserMfaState(userId, async (state, client) => {
      this.assertEnabledUserMfaState(state);
      const consumed = this.consumeMfaCode(userId, normalizedCode, state);
      await this.saveUserMfaState(userId, consumed.state, client);
      return { method: consumed.method };
    });
  }

  getPasswordPolicy() {
    return this.getSetting('password_policy', {
      minLength: 8,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSymbol: false,
      expireDays: 0,
      maxFailedAttempts: 5
    });
  }

  async assertPasswordMeetsPolicy(passwordInput: string | null | undefined) {
    const password = typeof passwordInput === 'string' ? passwordInput : '';
    if (!password || password.length > 160) {
      throw new BadRequestException('新密码长度必须在密码策略允许范围内。');
    }

    const policy = await this.getPasswordPolicy();
    const value = policy.value as Record<string, unknown>;
    const minLength = this.getPositiveIntegerSetting(value.minLength, 8);
    const failures: string[] = [];
    if (password.length < minLength) failures.push(`至少 ${minLength} 位`);
    if (this.getSettingBoolean(value.requireUppercase, true) && !/[A-Z]/.test(password)) {
      failures.push('包含大写字母');
    }
    if (this.getSettingBoolean(value.requireLowercase, true) && !/[a-z]/.test(password)) {
      failures.push('包含小写字母');
    }
    if (this.getSettingBoolean(value.requireNumber, true) && !/\d/.test(password)) {
      failures.push('包含数字');
    }
    if (this.getSettingBoolean(value.requireSymbol, false) && !/[^A-Za-z0-9\s]/.test(password)) {
      failures.push('包含符号');
    }

    if (failures.length) {
      throw new BadRequestException(`新密码必须${failures.join('、')}。`);
    }
  }

  updatePasswordPolicy(value: Record<string, unknown>, operator?: AuthenticatedUser) {
    return this.upsertSetting('password_policy', value, '密码策略', operator);
  }

  async listIpWhitelists(query: ListIpWhitelistsQuery) {
    const pagination = getPagination(query);
    const keyword = query.keyword?.trim();
    const scope = this.parseIpScope(query.scope, false);
    const enabled = this.parseBoolean(query.enabled);
    const where: Prisma.IpWhitelistWhereInput = {
      scope: scope ?? undefined,
      enabled,
      OR: keyword
        ? [{ ipOrCidr: { contains: keyword } }, { remark: { contains: keyword } }]
        : undefined
    };

    const [items, total] = await Promise.all([
      this.prisma.ipWhitelist.findMany({
        where,
        include: this.getIpWhitelistInclude(),
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildIpWhitelistOrderBy(query)
      }),
      this.prisma.ipWhitelist.count({ where })
    ]);

    return {
      items: items.map((item) => this.toIpWhitelistResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async createIpWhitelist(dto: SaveIpWhitelistInput, operator?: AuthenticatedUser) {
    const ipOrCidr = this.normalizeIpOrCidr(dto.ipOrCidr);
    const scope = this.parseIpScope(dto.scope ?? 'admin', true);
    const record = await this.prisma.ipWhitelist.create({
      data: {
        ipOrCidr,
        scope,
        enabled: dto.enabled ?? true,
        remark: this.normalizeNullableString(dto.remark),
        createdByUserId: operator?.id
      },
      include: this.getIpWhitelistInclude()
    });

    this.ipWhitelistCache.clear();
    this.overviewCache.clear();
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'security',
      action: 'security.ip_whitelist.create',
      objectType: 'ip_whitelist',
      objectId: record.id,
      afterData: this.toAuditJson(this.toIpWhitelistResponse(record)),
      remark: `Created IP whitelist ${record.ipOrCidr}`
    });

    return this.toIpWhitelistResponse(record);
  }

  async createIpWhitelistSafely(
    dto: SaveIpWhitelistInput,
    operator: AuthenticatedUser,
    requestIp?: string | null
  ) {
    const candidate = {
      id: '__new__',
      ipOrCidr: this.normalizeIpOrCidr(dto.ipOrCidr),
      enabled: dto.enabled ?? true
    };
    const records = await this.prisma.ipWhitelist.findMany({
      select: { id: true, ipOrCidr: true, enabled: true }
    });
    this.assertWhitelistMutationKeepsRequestIpAllowed([...records, candidate], requestIp);
    return this.createIpWhitelist(dto, operator);
  }

  private buildIpWhitelistOrderBy(
    query: ListIpWhitelistsQuery
  ): Prisma.IpWhitelistOrderByWithRelationInput[] {
    const sortField = query.sortBy ? IP_WHITELIST_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder = this.parseSortOrder(query.sortOrder);

    if (!sortField || !sortOrder) {
      return [{ createdAt: 'desc' }];
    }

    return [{ [sortField]: sortOrder }, { createdAt: 'desc' }];
  }

  async updateIpWhitelist(id: string, dto: SaveIpWhitelistInput, operator?: AuthenticatedUser) {
    const record = await this.findIpWhitelistOrThrow(id);
    const data: Prisma.IpWhitelistUpdateInput = {};

    if (dto.ipOrCidr !== undefined) data.ipOrCidr = this.normalizeIpOrCidr(dto.ipOrCidr);
    if (dto.scope !== undefined) {
      const scope = this.parseIpScope(dto.scope, true);
      data.scope = scope;
    }
    if (dto.enabled !== undefined) data.enabled = Boolean(dto.enabled);
    if (dto.remark !== undefined) data.remark = this.normalizeNullableString(dto.remark);

    const updated = await this.prisma.ipWhitelist.update({
      where: { id: record.id },
      data,
      include: this.getIpWhitelistInclude()
    });

    this.ipWhitelistCache.clear();
    this.overviewCache.clear();
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'security',
      action: 'security.ip_whitelist.update',
      objectType: 'ip_whitelist',
      objectId: record.id,
      beforeData: this.toAuditJson(this.toIpWhitelistResponse(record)),
      afterData: this.toAuditJson(this.toIpWhitelistResponse(updated)),
      remark: `Updated IP whitelist ${updated.ipOrCidr}`
    });

    return this.toIpWhitelistResponse(updated);
  }

  async updateIpWhitelistSafely(
    id: string,
    dto: SaveIpWhitelistInput,
    operator: AuthenticatedUser,
    requestIp?: string | null
  ) {
    const record = await this.findIpWhitelistOrThrow(id);
    const records = await this.prisma.ipWhitelist.findMany({
      select: { id: true, ipOrCidr: true, enabled: true }
    });
    const nextRecords = records.map((item) =>
      item.id === record.id
        ? {
            ...item,
            ipOrCidr:
              dto.ipOrCidr === undefined ? item.ipOrCidr : this.normalizeIpOrCidr(dto.ipOrCidr),
            enabled: dto.enabled === undefined ? item.enabled : dto.enabled
          }
        : item
    );
    this.assertWhitelistMutationKeepsRequestIpAllowed(nextRecords, requestIp);
    return this.updateIpWhitelist(record.id, dto, operator);
  }

  async removeIpWhitelist(id: string, operator?: AuthenticatedUser) {
    const record = await this.findIpWhitelistOrThrow(id);
    await this.prisma.ipWhitelist.delete({ where: { id: record.id } });

    this.ipWhitelistCache.clear();
    this.overviewCache.clear();
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'security',
      action: 'security.ip_whitelist.delete',
      objectType: 'ip_whitelist',
      objectId: record.id,
      beforeData: this.toAuditJson(this.toIpWhitelistResponse(record)),
      remark: `Deleted IP whitelist ${record.ipOrCidr}`
    });

    return { deleted: true };
  }

  async removeIpWhitelistSafely(
    id: string,
    operator: AuthenticatedUser,
    requestIp?: string | null
  ) {
    const record = await this.findIpWhitelistOrThrow(id);
    const records = await this.prisma.ipWhitelist.findMany({
      select: { id: true, ipOrCidr: true, enabled: true }
    });
    this.assertWhitelistMutationKeepsRequestIpAllowed(
      records.filter((item) => item.id !== record.id),
      requestIp
    );
    return this.removeIpWhitelist(record.id, operator);
  }

  async listSensitiveAccessLogs(query: ListSensitiveAccessLogsQuery) {
    const pagination = getPagination(query);
    const keyword = query.keyword?.trim();
    const approved = this.parseBoolean(query.approved);
    const where: Prisma.SensitiveAccessLogWhereInput = {
      module: query.module || undefined,
      fieldName: query.fieldName || undefined,
      approved,
      OR: keyword
        ? [
            { module: { contains: keyword } },
            { fieldName: { contains: keyword } },
            { objectType: { contains: keyword } },
            { accessReason: { contains: keyword } }
          ]
        : undefined
    };

    const [items, total] = await Promise.all([
      this.prisma.sensitiveAccessLog.findMany({
        where,
        include: this.getSensitiveAccessLogInclude(),
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildSensitiveAccessLogOrderBy(query)
      }),
      this.prisma.sensitiveAccessLog.count({ where })
    ]);

    return {
      items: items.map((item) => this.toSensitiveAccessLogResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  private buildSensitiveAccessLogOrderBy(
    query: ListSensitiveAccessLogsQuery
  ): Prisma.SensitiveAccessLogOrderByWithRelationInput[] {
    const sortField = query.sortBy ? SENSITIVE_ACCESS_LOG_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder = this.parseSortOrder(query.sortOrder);

    if (!sortField || !sortOrder) {
      return [{ createdAt: 'desc' }];
    }

    return [{ [sortField]: sortOrder }, { createdAt: 'desc' }];
  }

  async createSensitiveApproval(dto: CreateSensitiveApprovalInput, requester: AuthenticatedUser) {
    const approval = await this.prisma.sensitiveAccessApproval.create({
      data: {
        requesterId: requester.id,
        module: this.normalizeRequiredString(dto.module, 'module'),
        fieldName: this.normalizeRequiredString(dto.fieldName, 'fieldName'),
        objectType: this.normalizeRequiredString(dto.objectType, 'objectType'),
        objectId: this.normalizeNullableUuid(dto.objectId, 'objectId'),
        reason: this.normalizeRequiredString(dto.reason, 'reason'),
        expiresAt: this.parseNullableDate(dto.expiresAt, 'expiresAt')
      },
      include: this.getSensitiveApprovalInclude()
    });

    this.overviewCache.clear();
    await this.auditLogsService.create({
      userId: requester.id,
      module: 'security',
      action: 'security.sensitive_access_approval.create',
      objectType: 'sensitive_access_approval',
      objectId: approval.id,
      afterData: this.toAuditJson(this.toSensitiveApprovalResponse(approval)),
      remark: `Created sensitive access approval ${approval.id}`
    });

    return this.toSensitiveApprovalResponse(approval);
  }

  async listSensitiveApprovals(query: ListSensitiveApprovalsQuery) {
    const pagination = getPagination(query);
    const keyword = query.keyword?.trim();
    const status = this.parseApprovalStatus(query.status, false);
    const where: Prisma.SensitiveAccessApprovalWhereInput = {
      status: status ?? undefined,
      module: query.module || undefined,
      OR: keyword
        ? [
            { module: { contains: keyword } },
            { fieldName: { contains: keyword } },
            { objectType: { contains: keyword } },
            { reason: { contains: keyword } }
          ]
        : undefined
    };

    const [items, total] = await Promise.all([
      this.prisma.sensitiveAccessApproval.findMany({
        where,
        include: this.getSensitiveApprovalInclude(),
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildSensitiveApprovalOrderBy(query)
      }),
      this.prisma.sensitiveAccessApproval.count({ where })
    ]);

    return {
      items: items.map((item) => this.toSensitiveApprovalResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  private buildSensitiveApprovalOrderBy(
    query: ListSensitiveApprovalsQuery
  ): Prisma.SensitiveAccessApprovalOrderByWithRelationInput[] {
    const sortField = query.sortBy ? SENSITIVE_APPROVAL_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder = this.parseSortOrder(query.sortOrder);

    if (!sortField || !sortOrder) {
      return [{ createdAt: 'desc' }];
    }

    return [{ [sortField]: sortOrder }, { createdAt: 'desc' }];
  }

  approveSensitiveApproval(
    id: string,
    dto: DecideSensitiveApprovalInput,
    operator?: AuthenticatedUser
  ) {
    return this.decideSensitiveApproval(id, 'approved', dto, operator);
  }

  rejectSensitiveApproval(
    id: string,
    dto: DecideSensitiveApprovalInput,
    operator?: AuthenticatedUser
  ) {
    return this.decideSensitiveApproval(id, 'rejected', dto, operator);
  }

  async listSensitiveOperations(query: PaginationQuery & { keyword?: string }) {
    const pagination = getPagination(query);
    const keyword = query.keyword?.trim();
    const where: Prisma.AuditLogWhereInput = {
      OR: [
        { action: { contains: 'sensitive' } },
        { action: { contains: 'reveal' } },
        { module: { contains: 'security' } },
        ...(keyword
          ? [
              { action: { contains: keyword } },
              { module: { contains: keyword } },
              { remark: { contains: keyword } }
            ]
          : [])
      ]
    };

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: { id: true, username: true, displayName: true }
          }
        },
        skip: pagination.skip,
        take: pagination.take,
        orderBy: { createdAt: 'desc' }
      }),
      this.prisma.auditLog.count({ where })
    ]);

    return {
      items,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  private async decideSensitiveApproval(
    id: string,
    status: Extract<SensitiveAccessApprovalStatus, 'approved' | 'rejected'>,
    dto: DecideSensitiveApprovalInput,
    operator?: AuthenticatedUser
  ) {
    const approval = await this.findSensitiveApprovalOrThrow(id);
    const now = new Date();
    const updated = await this.prisma.sensitiveAccessApproval.update({
      where: { id: approval.id },
      data: {
        status,
        approverId: operator?.id,
        decisionNote: this.normalizeNullableString(dto.decisionNote),
        approvedAt: status === 'approved' ? now : null,
        expiresAt: this.parseNullableDate(dto.expiresAt, 'expiresAt') ?? approval.expiresAt
      },
      include: this.getSensitiveApprovalInclude()
    });

    this.overviewCache.clear();
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'security',
      action: `security.sensitive_access_approval.${status}`,
      objectType: 'sensitive_access_approval',
      objectId: approval.id,
      beforeData: this.toAuditJson(this.toSensitiveApprovalResponse(approval)),
      afterData: this.toAuditJson(this.toSensitiveApprovalResponse(updated)),
      remark: `${status} sensitive access approval ${approval.id}`
    });

    return this.toSensitiveApprovalResponse(updated);
  }

  private async getSetting(key: string, fallback: Record<string, unknown>) {
    const setting = await this.prisma.securitySetting.findUnique({ where: { key } });
    return this.toSettingResponse(setting, key, fallback);
  }

  private async upsertSetting(
    key: string,
    value: Record<string, unknown>,
    remark: string,
    operator?: AuthenticatedUser
  ) {
    const normalizedValue = this.toAuditJson(value);
    const setting = await this.prisma.securitySetting.upsert({
      where: { key },
      update: {
        value: normalizedValue,
        remark,
        updatedByUserId: operator?.id
      },
      create: {
        key,
        value: normalizedValue,
        remark,
        updatedByUserId: operator?.id
      }
    });

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'security',
      action: `security.setting.${key}.update`,
      objectType: 'security_setting',
      objectId: setting.id,
      afterData: this.toAuditJson(this.toSettingResponse(setting, key, value)),
      remark: `Updated security setting ${key}`
    });

    return this.toSettingResponse(setting, key, value);
  }

  private async getUserMfaState(
    userId: string,
    client: Pick<Prisma.TransactionClient, 'securitySetting'> = this.prisma
  ): Promise<UserMfaState> {
    const setting = await client.securitySetting.findUnique({
      where: { key: this.getUserMfaSettingKey(userId) }
    });
    return this.parseUserMfaState(setting?.value);
  }

  private async findUnboundActiveAdmins() {
    const admins = await this.prisma.user.findMany({
      where: {
        status: 'active',
        deletedAt: null,
        userRoles: {
          some: { role: { code: 'admin' } }
        }
      },
      select: { id: true }
    });
    if (!admins.length) return [];

    const settings = await this.prisma.securitySetting.findMany({
      where: {
        key: { in: admins.map((user) => this.getUserMfaSettingKey(user.id)) }
      },
      select: { key: true, value: true }
    });
    const settingsByKey = new Map(settings.map((setting) => [setting.key, setting.value]));
    return admins.filter((user) => {
      const state = this.parseUserMfaState(settingsByKey.get(this.getUserMfaSettingKey(user.id)));
      return !state.enabled || !state.secretEncrypted;
    });
  }

  private assertEnabledUserMfaState(state: UserMfaState) {
    if (!state.enabled || !state.secretEncrypted) {
      throw new BadRequestException('MFA is not enabled');
    }
  }

  private async saveUserMfaState(
    userId: string,
    state: UserMfaState,
    client: Pick<Prisma.TransactionClient, 'securitySetting'> = this.prisma
  ) {
    const key = this.getUserMfaSettingKey(userId);
    const normalizedState: UserMfaState = {
      ...state,
      recoveryCodeHashes: state.recoveryCodeHashes ?? [],
      recoveryCodeCount: state.recoveryCodeHashes?.length ?? state.recoveryCodeCount ?? 0
    };
    const setting = await client.securitySetting.upsert({
      where: { key },
      update: {
        value: this.toAuditJson(normalizedState),
        remark: '用户 MFA 绑定状态',
        updatedByUserId: userId
      },
      create: {
        key,
        value: this.toAuditJson(normalizedState),
        remark: '用户 MFA 绑定状态',
        updatedByUserId: userId
      }
    });
    return this.parseUserMfaState(setting.value);
  }

  private async withLockedUserMfaState<T>(
    userIdInput: string,
    operation: (state: UserMfaState, client: MfaStateClient) => Promise<T> | T
  ) {
    const userId = this.normalizeRequiredUuid(userIdInput, 'userId');
    return this.prisma.$transaction(async (client) => {
      await acquireMysqlTransactionLock(client, `security:mfa:${userId}`);
      const state = await this.getUserMfaState(userId, client);
      return operation(state, client);
    });
  }

  private consumeMfaCode(userId: string, code: string, state: UserMfaState): ConsumedMfaCode {
    const secret = this.getMfaSecretOrThrow(state);
    const totpVerification = this.verifyTotp(secret, code, state.lastUsedCounter ?? null);
    if (totpVerification.valid) {
      return {
        method: 'totp',
        state: {
          ...state,
          lastUsedAt: new Date().toISOString(),
          lastUsedCounter: totpVerification.counter
        }
      };
    }

    const recoveryCodeHashes = state.recoveryCodeHashes ?? [];
    const recoveryHash = this.hashRecoveryCode(userId, code);
    const recoveryIndex = recoveryCodeHashes.findIndex((hash) =>
      this.safeEqualHash(hash, recoveryHash)
    );
    if (recoveryIndex >= 0) {
      const remainingHashes = recoveryCodeHashes.filter((_, index) => index !== recoveryIndex);
      return {
        method: 'recovery_code',
        state: {
          ...state,
          recoveryCodeHashes: remainingHashes,
          recoveryCodeCount: remainingHashes.length,
          lastUsedAt: new Date().toISOString()
        }
      };
    }

    throw new BadRequestException('动态验证码或恢复码错误，请重新输入。');
  }

  private parseUserMfaState(value: unknown): UserMfaState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { enabled: false, recoveryCodeHashes: [], recoveryCodeCount: 0 };
    }
    const data = value as Record<string, unknown>;
    return {
      enabled: Boolean(data.enabled),
      secretEncrypted: typeof data.secretEncrypted === 'string' ? data.secretEncrypted : null,
      recoveryCodeHashes: Array.isArray(data.recoveryCodeHashes)
        ? data.recoveryCodeHashes.filter((item): item is string => typeof item === 'string')
        : [],
      recoveryCodeCount:
        typeof data.recoveryCodeCount === 'number' ? data.recoveryCodeCount : undefined,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
      enabledAt: typeof data.enabledAt === 'string' ? data.enabledAt : null,
      lastUsedAt: typeof data.lastUsedAt === 'string' ? data.lastUsedAt : null,
      lastUsedCounter: typeof data.lastUsedCounter === 'number' ? data.lastUsedCounter : null,
      disabledAt: typeof data.disabledAt === 'string' ? data.disabledAt : null,
      disabledReason: typeof data.disabledReason === 'string' ? data.disabledReason : null
    };
  }

  private toMfaStatusResponse(state: UserMfaState) {
    return {
      enabled: Boolean(state.enabled),
      configured: Boolean(state.secretEncrypted),
      recoveryCodeCount: state.recoveryCodeHashes?.length ?? state.recoveryCodeCount ?? 0,
      enabledAt: state.enabledAt ?? null,
      lastUsedAt: state.lastUsedAt ?? null,
      disabledAt: state.disabledAt ?? null
    };
  }

  private getUserMfaSettingKey(userId: string) {
    return `mfa_user_${this.normalizeRequiredUuid(userId, 'userId')}`;
  }

  private getMfaSecretOrThrow(state: UserMfaState) {
    const secret = this.fieldEncryptionService.decrypt(state.secretEncrypted);
    if (!secret) {
      throw new BadRequestException('动态验证码还没有配置，请先重新绑定。');
    }
    return secret;
  }

  private getMfaIssuer(settingValue: unknown) {
    const issuer =
      settingValue && typeof settingValue === 'object' && !Array.isArray(settingValue)
        ? (settingValue as Record<string, unknown>).issuer
        : undefined;
    return typeof issuer === 'string' && issuer.trim() ? issuer.trim() : '代充管理后台';
  }

  private buildOtpAuthUrl(input: { issuer: string; accountName: string; secret: string }) {
    const label = `${input.issuer}:${input.accountName}`;
    const params = new URLSearchParams({
      secret: input.secret,
      issuer: input.issuer,
      algorithm: 'SHA1',
      digits: String(MFA_TOTP_DIGITS),
      period: String(MFA_TOTP_PERIOD_SECONDS)
    });
    return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
  }

  private generateBase32Secret() {
    return this.base32Encode(randomBytes(20));
  }

  private generateRecoveryCodes() {
    return Array.from({ length: MFA_RECOVERY_CODE_COUNT }, () =>
      randomBytes(MFA_RECOVERY_CODE_BYTES).toString('hex').toUpperCase()
    );
  }

  private normalizeMfaCode(value: string | null | undefined) {
    const code = this.normalizeNullableString(value)?.replace(/\s+/g, '').toUpperCase();
    if (!code) {
      throw new BadRequestException('需要输入动态验证码或恢复码。');
    }
    return code;
  }

  private verifyTotp(secret: string, code: string, lastUsedCounter?: number | null) {
    if (!/^\d{6}$/.test(code)) {
      return { valid: false, counter: null };
    }
    const nowCounter = Math.floor(Date.now() / 1000 / MFA_TOTP_PERIOD_SECONDS);
    for (let offset = -MFA_TOTP_WINDOW; offset <= MFA_TOTP_WINDOW; offset += 1) {
      const counter = nowCounter + offset;
      if (lastUsedCounter !== undefined && lastUsedCounter !== null && counter <= lastUsedCounter) {
        continue;
      }
      const expected = this.generateTotp(secret, counter);
      if (this.safeEqualHash(expected, code)) {
        return { valid: true, counter };
      }
    }
    return { valid: false, counter: null };
  }

  private generateTotp(secret: string, counter: number) {
    const key = this.base32Decode(secret);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    counterBuffer.writeUInt32BE(counter >>> 0, 4);
    const hmac = createHmac('sha1', key).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return String(binary % 10 ** MFA_TOTP_DIGITS).padStart(MFA_TOTP_DIGITS, '0');
  }

  private base32Encode(buffer: Buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        output += MFA_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) {
      output += MFA_BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
  }

  private base32Decode(value: string) {
    const normalized = value.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
    let bits = 0;
    let buffer = 0;
    const bytes: number[] = [];
    for (const char of normalized) {
      const index = MFA_BASE32_ALPHABET.indexOf(char);
      if (index < 0) {
        throw new BadRequestException('MFA secret is invalid');
      }
      buffer = (buffer << 5) | index;
      bits += 5;
      if (bits >= 8) {
        bytes.push((buffer >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  }

  private hashRecoveryCode(userId: string, code: string) {
    return this.fieldEncryptionService.hash(`mfa:${userId}:${code}`) ?? '';
  }

  private safeEqualHash(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  private async getLoginFailureRiskContext(
    username: string,
    ip: string | null
  ): Promise<LoginRiskContext> {
    const policy = await this.getPasswordPolicy();
    const threshold = this.getPositiveIntegerSetting(
      (policy.value as Record<string, unknown>).maxFailedAttempts,
      LOGIN_FAILURE_THRESHOLD
    );
    const windowStart = new Date(Date.now() - LOGIN_FAILURE_WINDOW_MINUTES * 60 * 1000);
    const baseWhere: Prisma.LoginLogWhereInput = {
      status: { in: LOGIN_FAILURE_STATUSES },
      createdAt: { gte: windowStart }
    };
    const countQueries = [
      this.prisma.loginLog.count({
        where: {
          ...baseWhere,
          username
        }
      })
    ];

    if (ip) {
      countQueries.push(
        this.prisma.loginLog.count({
          where: {
            ...baseWhere,
            ip
          }
        })
      );
    }

    const [usernameFailureCount = 0, ipFailureCount = 0] = await Promise.all(countQueries);
    const failureCount = Math.max(usernameFailureCount, ipFailureCount) + 1;

    return {
      continuousFailure: failureCount >= threshold,
      failureCount,
      threshold,
      windowMinutes: LOGIN_FAILURE_WINDOW_MINUTES
    };
  }

  private async findIpWhitelistOrThrow(id: string) {
    const record = await this.prisma.ipWhitelist.findUnique({
      where: { id: this.normalizeRequiredUuid(id, 'id') },
      include: this.getIpWhitelistInclude()
    });
    if (!record) throw new NotFoundException('IP whitelist not found');
    return record;
  }

  private async findSensitiveApprovalOrThrow(id: string) {
    const approval = await this.prisma.sensitiveAccessApproval.findUnique({
      where: { id: this.normalizeRequiredUuid(id, 'id') },
      include: this.getSensitiveApprovalInclude()
    });
    if (!approval) throw new NotFoundException('Sensitive access approval not found');
    return approval;
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private cacheActiveToken(tokenHash: string, expiresAt: Date, now = new Date()) {
    const ttlMs = Math.min(ACTIVE_TOKEN_CACHE_TTL_MS, expiresAt.getTime() - now.getTime());
    if (ttlMs <= 0) return;
    this.activeTokenCache.set(tokenHash, true, ttlMs);
  }

  private getIpWhitelistCacheKey(scopes: IpWhitelistScope[]) {
    return [...new Set(scopes)].sort().join('|');
  }

  private parseLoginStatus(value: unknown, strict: true): LoginLogStatus;
  private parseLoginStatus(value: unknown, strict?: false): LoginLogStatus | undefined;
  private parseLoginStatus(value: unknown, strict = true) {
    if (value === undefined || value === null || value === '') {
      if (strict) throw new BadRequestException('status is required');
      return undefined;
    }
    if (value === 'success' || value === 'failed' || value === 'blocked') return value;
    throw new BadRequestException('status is invalid');
  }

  private parseIpScope(value: unknown, strict: true): IpWhitelistScope;
  private parseIpScope(value: unknown, strict?: false): IpWhitelistScope | undefined;
  private parseIpScope(value: unknown, strict = true) {
    if (value === undefined || value === null || value === '') {
      if (strict) throw new BadRequestException('scope is required');
      return undefined;
    }
    if (value === 'admin' || value === 'api') return value;
    throw new BadRequestException('scope is invalid');
  }

  private parseApprovalStatus(value: unknown, strict: true): SensitiveAccessApprovalStatus;
  private parseApprovalStatus(
    value: unknown,
    strict?: false
  ): SensitiveAccessApprovalStatus | undefined;
  private parseApprovalStatus(value: unknown, strict = true) {
    if (value === undefined || value === null || value === '') {
      if (strict) throw new BadRequestException('status is required');
      return undefined;
    }
    if (
      value === 'pending' ||
      value === 'approved' ||
      value === 'rejected' ||
      value === 'expired'
    ) {
      return value;
    }
    throw new BadRequestException('status is invalid');
  }

  private parseSortOrder(value?: string): Prisma.SortOrder | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (value === 'asc' || value === 'desc') {
      return value;
    }

    throw new BadRequestException('sortOrder is invalid');
  }

  private parseBoolean(value: unknown) {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
  }

  private getSettingBoolean(value: unknown, fallback: boolean) {
    return typeof value === 'boolean' ? value : fallback;
  }

  private getPositiveIntegerSetting(value: unknown, fallback: number) {
    const numberValue = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : fallback;
  }

  private isAdminUser(user: AuthenticatedUser) {
    return user.roles.includes('admin');
  }

  private parseNullableDate(value: string | null | undefined, field: string) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid date`);
    }
    return date;
  }

  private normalizeIpOrCidr(value: unknown) {
    const normalized = this.normalizeRequiredString(value, 'ipOrCidr');
    if (!normalized.includes('/')) {
      if (!isIP(normalized)) {
        throw new BadRequestException('请输入有效的 IPv4 或 IPv6 地址。');
      }
      return normalized;
    }

    const [network, prefixText, extra] = normalized.split('/');
    if (extra !== undefined || isIP(network) !== 4) {
      throw new BadRequestException('CIDR 当前仅支持 IPv4 网段；IPv6 请填写单个地址。');
    }
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new BadRequestException('IPv4 CIDR 前缀必须为 0 至 32。');
    }
    return `${network}/${prefix}`;
  }

  private normalizeRequestIp(value: string | null | undefined) {
    const firstIp = this.normalizeNullableString(value)?.split(',')[0]?.trim() ?? null;
    if (!firstIp) {
      return null;
    }

    return firstIp.startsWith('::ffff:') ? firstIp.slice('::ffff:'.length) : firstIp;
  }

  private assertWhitelistMutationKeepsRequestIpAllowed(
    records: Array<{ ipOrCidr: string; enabled: boolean }>,
    requestIp?: string | null
  ) {
    const enabledRecords = records.filter((record) => record.enabled);
    if (!enabledRecords.length) return;

    const normalizedIp = this.normalizeRequestIp(requestIp);
    if (!normalizedIp) {
      throw new BadRequestException('无法确认当前请求 IP，不能修改启用的白名单。');
    }
    if (!enabledRecords.some((record) => this.matchesIpOrCidr(normalizedIp, record.ipOrCidr))) {
      throw new BadRequestException('修改后当前请求 IP 将不在白名单内，已阻止本次操作。');
    }
  }

  private matchesIpOrCidr(ip: string, ipOrCidr: string) {
    const normalizedEntry = this.normalizeRequestIp(ipOrCidr);
    if (!normalizedEntry) {
      return false;
    }

    if (!normalizedEntry.includes('/')) {
      return normalizedEntry === ip;
    }

    const [network, prefixText] = normalizedEntry.split('/');
    const prefix = Number(prefixText);
    const ipInt = this.ipv4ToInt(ip);
    const networkInt = this.ipv4ToInt(network);

    if (
      ipInt === null ||
      networkInt === null ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > 32
    ) {
      return false;
    }

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (networkInt & mask);
  }

  private ipv4ToInt(value: string | undefined) {
    if (!value || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
      return null;
    }

    const parts = value.split('.').map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }

    return (
      ((parts[0] << 24) >>> 0) +
      ((parts[1] << 16) >>> 0) +
      ((parts[2] << 8) >>> 0) +
      (parts[3] >>> 0)
    );
  }

  private normalizeRequiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }
    return value.trim();
  }

  private normalizeNullableString(value: string | null | undefined) {
    if (value === null || value === undefined) return null;
    const normalized = value.trim();
    return normalized || null;
  }

  private normalizeRequiredUuid(value: unknown, field: string) {
    const normalized = this.normalizeRequiredString(value, field);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalized)) {
      throw new BadRequestException(`${field} must be a uuid`);
    }
    return normalized;
  }

  private getCountNumber(value: bigint | number | string | null) {
    const numberValue = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
    if (!Number.isFinite(numberValue)) return 0;
    return Math.max(0, Math.trunc(numberValue));
  }

  private normalizeNullableUuid(value: string | null | undefined, field: string) {
    if (!value) return null;
    return this.normalizeRequiredUuid(value, field);
  }

  private getLoginLogInclude() {
    return {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      }
    } satisfies Prisma.LoginLogInclude;
  }

  private getSessionInclude() {
    return {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      }
    } satisfies Prisma.ActiveSessionInclude;
  }

  private getIpWhitelistInclude() {
    return {
      createdBy: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      }
    } satisfies Prisma.IpWhitelistInclude;
  }

  private getSensitiveAccessLogInclude() {
    return {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      }
    } satisfies Prisma.SensitiveAccessLogInclude;
  }

  private getSensitiveApprovalInclude() {
    return {
      requester: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      },
      approver: {
        select: {
          id: true,
          username: true,
          displayName: true
        }
      }
    } satisfies Prisma.SensitiveAccessApprovalInclude;
  }

  private toLoginLogResponse(log: LoginLog & { user?: UserSnapshot | null }) {
    return {
      id: log.id,
      userId: log.userId,
      user: log.user ? this.toUserSnapshot(log.user) : null,
      username: log.username,
      status: log.status,
      failureReason: log.failureReason,
      ip: log.ip,
      userAgent: log.userAgent,
      location: log.location,
      abnormal: log.abnormal,
      createdAt: log.createdAt
    };
  }

  private toSessionResponse(session: ActiveSession & { user: UserSnapshot }) {
    return {
      id: session.id,
      userId: session.userId,
      user: this.toUserSnapshot(session.user),
      ip: session.ip,
      userAgent: session.userAgent,
      lastActiveAt: session.lastActiveAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      createdAt: session.createdAt
    };
  }

  private toSettingResponse(
    setting: SecuritySetting | null,
    key: string,
    fallback: Record<string, unknown>
  ) {
    return {
      id: setting?.id ?? null,
      key,
      value: setting?.value ?? fallback,
      remark: setting?.remark ?? null,
      updatedByUserId: setting?.updatedByUserId ?? null,
      createdAt: setting?.createdAt ?? null,
      updatedAt: setting?.updatedAt ?? null
    };
  }

  private toIpWhitelistResponse(record: IpWhitelist & { createdBy?: UserSnapshot | null }) {
    return {
      id: record.id,
      ipOrCidr: record.ipOrCidr,
      scope: record.scope,
      enabled: record.enabled,
      remark: record.remark,
      createdByUserId: record.createdByUserId,
      createdBy: record.createdBy ? this.toUserSnapshot(record.createdBy) : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  private toSensitiveAccessLogResponse(log: SensitiveAccessLog & { user?: UserSnapshot | null }) {
    return {
      id: log.id,
      userId: log.userId,
      user: log.user ? this.toUserSnapshot(log.user) : null,
      module: log.module,
      fieldName: log.fieldName,
      objectType: log.objectType,
      objectId: log.objectId,
      accessReason: log.accessReason,
      approved: log.approved,
      ip: log.ip,
      userAgent: log.userAgent,
      createdAt: log.createdAt
    };
  }

  private toSensitiveApprovalResponse(
    approval: SensitiveAccessApproval & {
      requester: UserSnapshot;
      approver?: UserSnapshot | null;
    }
  ) {
    return {
      id: approval.id,
      requesterId: approval.requesterId,
      requester: this.toUserSnapshot(approval.requester),
      approverId: approval.approverId,
      approver: approval.approver ? this.toUserSnapshot(approval.approver) : null,
      module: approval.module,
      fieldName: approval.fieldName,
      objectType: approval.objectType,
      objectId: approval.objectId,
      reason: approval.reason,
      status: approval.status,
      decisionNote: approval.decisionNote,
      approvedAt: approval.approvedAt,
      expiresAt: approval.expiresAt,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt
    };
  }

  private toUserSnapshot(user: UserSnapshot) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName
    };
  }

  private toAuditJson(data: unknown) {
    return JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
  }
}

interface UserSnapshot {
  id: string;
  username: string;
  displayName: string;
}
