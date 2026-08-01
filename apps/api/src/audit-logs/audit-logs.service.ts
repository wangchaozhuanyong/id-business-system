import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { TimedMemoryCache } from '../common/cache/timed-memory-cache';
import { getPagination } from '../common/pagination';
import { PrismaService } from '../common/prisma/prisma.service';
import type {
  CreateAuditLogInput,
  ExportAuditLogsInput,
  ListAuditLogsQuery,
  ListSensitiveAccessLogsQuery
} from './audit-logs.types';

type AuditLogClient = Pick<Prisma.TransactionClient, 'auditLog'>;

const AUDIT_LOG_SORT_FIELDS: Record<string, keyof Prisma.AuditLogOrderByWithRelationInput> = {
  createdAt: 'createdAt',
  module: 'module',
  action: 'action',
  objectType: 'objectType'
};
const SENSITIVE_ACCESS_SORT_FIELDS: Record<
  string,
  keyof Prisma.SensitiveAccessLogOrderByWithRelationInput
> = {
  createdAt: 'createdAt',
  module: 'module',
  fieldName: 'fieldName',
  objectType: 'objectType',
  approved: 'approved'
};
const AUDIT_LIST_CACHE_TTL_MS = 120_000;
const AUDIT_EXPORT_LIMIT = 1_000;
const MALAYSIA_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_AUDIT_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'securityinfo',
  'securityanswers',
  'phone',
  'phonenumber',
  'phoneencrypted',
  'cardnumber',
  'giftcardnumber',
  'token',
  'tokenhash',
  'accesstoken',
  'refreshtoken',
  'jwt',
  'secret',
  'secretencrypted',
  'recoverycodes'
]);
const AUDIT_USER_INCLUDE = {
  user: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  }
} satisfies Prisma.AuditLogInclude;
const SENSITIVE_ACCESS_USER_INCLUDE = {
  user: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  }
} satisfies Prisma.SensitiveAccessLogInclude;

@Injectable()
export class AuditLogsService {
  private readonly listCache = new TimedMemoryCache();

  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateAuditLogInput, client: AuditLogClient = this.prisma) {
    const log = await client.auditLog.create({
      data: {
        userId: input.userId,
        module: input.module,
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        beforeData: this.sanitizeAuditJsonInput(input.beforeData),
        afterData: this.sanitizeAuditJsonInput(input.afterData),
        ip: input.ip,
        userAgent: input.userAgent,
        remark: input.remark
      }
    });
    this.listCache.clear();
    return log;
  }

  async list(query: ListAuditLogsQuery) {
    return this.listCache.getOrSet(
      this.getListCacheKey('operations', query),
      AUDIT_LIST_CACHE_TTL_MS,
      async () => {
        const pagination = getPagination(query);
        const where = this.buildAuditLogWhere(query);
        const [items, total] = await Promise.all([
          this.prisma.auditLog.findMany({
            where,
            skip: pagination.skip,
            take: pagination.take,
            orderBy: this.buildAuditLogOrderBy(query),
            include: AUDIT_USER_INCLUDE
          }),
          this.prisma.auditLog.count({ where })
        ]);

        return {
          items: items.map((item) => this.toAuditLogResponse(item)),
          total,
          page: pagination.page,
          pageSize: pagination.pageSize
        };
      }
    );
  }

  async listSensitiveAccess(query: ListSensitiveAccessLogsQuery) {
    return this.listCache.getOrSet(
      this.getListCacheKey('sensitive-access', query),
      AUDIT_LIST_CACHE_TTL_MS,
      async () => {
        const pagination = getPagination(query);
        const where = this.buildSensitiveAccessWhere(query);
        const [items, total] = await Promise.all([
          this.prisma.sensitiveAccessLog.findMany({
            where,
            skip: pagination.skip,
            take: pagination.take,
            orderBy: this.buildSensitiveAccessOrderBy(query),
            include: SENSITIVE_ACCESS_USER_INCLUDE
          }),
          this.prisma.sensitiveAccessLog.count({ where })
        ]);

        return {
          items,
          total,
          page: pagination.page,
          pageSize: pagination.pageSize
        };
      }
    );
  }

  async export(input: ExportAuditLogsInput, operator?: AuthenticatedUser) {
    const kind = input.kind ?? 'operations';
    const generatedAt = new Date().toISOString();

    if (kind === 'sensitive_access') {
      const query: ListSensitiveAccessLogsQuery = input;
      const where = this.buildSensitiveAccessWhere(query);
      const [items, total] = await Promise.all([
        this.prisma.sensitiveAccessLog.findMany({
          where,
          take: AUDIT_EXPORT_LIMIT,
          orderBy: this.buildSensitiveAccessOrderBy(query),
          include: SENSITIVE_ACCESS_USER_INCLUDE
        }),
        this.prisma.sensitiveAccessLog.count({ where })
      ]);
      await this.recordExport(operator, kind, items.length, total);
      return {
        kind,
        items,
        total,
        exportedCount: items.length,
        capped: total > items.length,
        generatedAt
      };
    }

    if (kind !== 'operations') {
      throw new BadRequestException('kind is invalid');
    }

    const query: ListAuditLogsQuery = input;
    const where = this.buildAuditLogWhere(query);
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        take: AUDIT_EXPORT_LIMIT,
        orderBy: this.buildAuditLogOrderBy(query),
        include: AUDIT_USER_INCLUDE
      }),
      this.prisma.auditLog.count({ where })
    ]);
    const safeItems = items.map((item) => this.toAuditLogResponse(item));
    await this.recordExport(operator, kind, safeItems.length, total);
    return {
      kind,
      items: safeItems,
      total,
      exportedCount: safeItems.length,
      capped: total > safeItems.length,
      generatedAt
    };
  }

  private buildAuditLogWhere(query: ListAuditLogsQuery): Prisma.AuditLogWhereInput {
    const keyword = query.keyword?.trim();
    const operator = query.operator?.trim();
    const module = query.module?.trim();
    const action = query.action?.trim();
    return {
      module: module ? { contains: module, mode: 'insensitive' } : undefined,
      action: action ? { contains: action, mode: 'insensitive' } : undefined,
      createdAt: this.buildCreatedAtRange(query.createdFrom, query.createdTo),
      user: operator
        ? {
            is: {
              OR: [
                { username: { contains: operator, mode: 'insensitive' } },
                { displayName: { contains: operator, mode: 'insensitive' } }
              ]
            }
          }
        : undefined,
      OR: keyword
        ? [
            { module: { contains: keyword, mode: 'insensitive' } },
            { action: { contains: keyword, mode: 'insensitive' } },
            { remark: { contains: keyword, mode: 'insensitive' } },
            { objectType: { contains: keyword, mode: 'insensitive' } },
            {
              user: {
                is: {
                  OR: [
                    { username: { contains: keyword, mode: 'insensitive' } },
                    { displayName: { contains: keyword, mode: 'insensitive' } }
                  ]
                }
              }
            }
          ]
        : undefined
    };
  }

  private buildSensitiveAccessWhere(
    query: ListSensitiveAccessLogsQuery
  ): Prisma.SensitiveAccessLogWhereInput {
    const keyword = query.keyword?.trim();
    const operator = query.operator?.trim();
    const module = query.module?.trim();
    const fieldName = query.fieldName?.trim();
    return {
      module: module ? { contains: module, mode: 'insensitive' } : undefined,
      fieldName: fieldName ? { contains: fieldName, mode: 'insensitive' } : undefined,
      approved: this.parseApproved(query.approved),
      createdAt: this.buildCreatedAtRange(query.createdFrom, query.createdTo),
      user: operator
        ? {
            is: {
              OR: [
                { username: { contains: operator, mode: 'insensitive' } },
                { displayName: { contains: operator, mode: 'insensitive' } }
              ]
            }
          }
        : undefined,
      OR: keyword
        ? [
            { module: { contains: keyword, mode: 'insensitive' } },
            { fieldName: { contains: keyword, mode: 'insensitive' } },
            { objectType: { contains: keyword, mode: 'insensitive' } },
            { accessReason: { contains: keyword, mode: 'insensitive' } },
            {
              user: {
                is: {
                  OR: [
                    { username: { contains: keyword, mode: 'insensitive' } },
                    { displayName: { contains: keyword, mode: 'insensitive' } }
                  ]
                }
              }
            }
          ]
        : undefined
    };
  }

  private buildAuditLogOrderBy(
    query: ListAuditLogsQuery
  ): Prisma.AuditLogOrderByWithRelationInput[] {
    const sortField = query.sortBy ? AUDIT_LOG_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder = this.parseSortOrder(query.sortOrder);
    if (!sortField || !sortOrder) return [{ createdAt: 'desc' }];
    return [{ [sortField]: sortOrder }, { createdAt: 'desc' }];
  }

  private buildSensitiveAccessOrderBy(
    query: ListSensitiveAccessLogsQuery
  ): Prisma.SensitiveAccessLogOrderByWithRelationInput[] {
    const sortField = query.sortBy ? SENSITIVE_ACCESS_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder = this.parseSortOrder(query.sortOrder);
    if (!sortField || !sortOrder) return [{ createdAt: 'desc' }];
    return [{ [sortField]: sortOrder }, { createdAt: 'desc' }];
  }

  private buildCreatedAtRange(createdFrom?: string, createdTo?: string) {
    const from = createdFrom ? this.parseMalaysiaDate(createdFrom, false) : undefined;
    const to = createdTo ? this.parseMalaysiaDate(createdTo, true) : undefined;
    if (from && to && from >= to) {
      throw new BadRequestException('created date range is invalid');
    }
    if (!from && !to) return undefined;
    return {
      gte: from,
      lt: to
    } satisfies Prisma.DateTimeFilter;
  }

  private parseMalaysiaDate(value: string, endExclusive: boolean) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) throw new BadRequestException('created date is invalid');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    if (
      utcDate.getUTCFullYear() !== year ||
      utcDate.getUTCMonth() !== month - 1 ||
      utcDate.getUTCDate() !== day
    ) {
      throw new BadRequestException('created date is invalid');
    }
    return new Date(utcDate.getTime() - MALAYSIA_UTC_OFFSET_MS + (endExclusive ? ONE_DAY_MS : 0));
  }

  private parseApproved(value?: string) {
    if (!value) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException('approved is invalid');
  }

  private parseSortOrder(value?: string): Prisma.SortOrder | undefined {
    if (!value) return undefined;
    if (value === 'asc' || value === 'desc') return value;
    throw new BadRequestException('sortOrder is invalid');
  }

  private toAuditLogResponse<
    T extends { beforeData: Prisma.JsonValue | null; afterData: Prisma.JsonValue | null }
  >(item: T) {
    return {
      ...item,
      beforeData: this.sanitizeAuditJsonValue(item.beforeData),
      afterData: this.sanitizeAuditJsonValue(item.afterData)
    };
  }

  private sanitizeAuditJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    return this.sanitizeAuditJsonValue(value) as Prisma.InputJsonValue;
  }

  private sanitizeAuditJsonValue(value: unknown): Prisma.JsonValue {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeAuditJsonValue(item));
    }
    if (typeof value === 'object') {
      const sanitized: Record<string, Prisma.JsonValue> = {};
      for (const [key, item] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
        sanitized[key] = SENSITIVE_AUDIT_KEYS.has(normalizedKey)
          ? REDACTED_VALUE
          : this.sanitizeAuditJsonValue(item);
      }
      return sanitized;
    }
    return String(value);
  }

  private recordExport(
    operator: AuthenticatedUser | undefined,
    kind: 'operations' | 'sensitive_access',
    exportedCount: number,
    total: number
  ) {
    return this.create({
      userId: operator?.id,
      module: 'audit_logs',
      action: 'audit_logs.export',
      objectType: kind,
      afterData: {
        kind,
        exportedCount,
        total,
        capped: total > exportedCount
      },
      remark: `导出${kind === 'operations' ? '操作审计' : '敏感访问'}记录 ${exportedCount} 条`
    });
  }

  private getListCacheKey(prefix: string, query: object) {
    const params = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([left], [right]) => left.localeCompare(right));
    return `audit:${prefix}:${JSON.stringify(params)}`;
  }
}
