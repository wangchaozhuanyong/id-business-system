import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TimedMemoryCache } from '../common/cache/timed-memory-cache';
import { getPagination, type PaginationQuery } from '../common/pagination';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateAuditLogInput } from './audit-logs.types';

type AuditLogClient = Pick<Prisma.TransactionClient, 'auditLog'>;

interface ListAuditLogsQuery extends PaginationQuery {
  module?: string;
  action?: string;
  userId?: string;
  keyword?: string;
  sortBy?: string;
  sortOrder?: string;
}

const AUDIT_LOG_SORT_FIELDS: Record<string, keyof Prisma.AuditLogOrderByWithRelationInput> = {
  createdAt: 'createdAt',
  module: 'module',
  action: 'action',
  objectType: 'objectType'
};
const AUDIT_LIST_CACHE_TTL_MS = 120_000;

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
        beforeData: input.beforeData,
        afterData: input.afterData,
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
      this.getListCacheKey(query),
      AUDIT_LIST_CACHE_TTL_MS,
      async () => {
        const pagination = getPagination(query);
        const keyword = query.keyword?.trim();
        const where: Prisma.AuditLogWhereInput = {
          module: query.module || undefined,
          action: query.action || undefined,
          userId: query.userId || undefined,
          OR: keyword
            ? [
                { remark: { contains: keyword, mode: 'insensitive' } },
                { objectType: { contains: keyword, mode: 'insensitive' } }
              ]
            : undefined
        };

        const [items, total] = await Promise.all([
          this.prisma.auditLog.findMany({
            where,
            skip: pagination.skip,
            take: pagination.take,
            orderBy: this.buildOrderBy(query),
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  displayName: true
                }
              }
            }
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
    );
  }

  private buildOrderBy(query: ListAuditLogsQuery): Prisma.AuditLogOrderByWithRelationInput[] {
    const sortField = query.sortBy ? AUDIT_LOG_SORT_FIELDS[query.sortBy] : undefined;
    const sortOrder = this.parseSortOrder(query.sortOrder);
    if (!sortField || !sortOrder) return [{ createdAt: 'desc' }];
    return [{ [sortField]: sortOrder }, { createdAt: 'desc' }];
  }

  private parseSortOrder(value?: string): Prisma.SortOrder | undefined {
    if (!value) return undefined;
    if (value === 'asc' || value === 'desc') return value;
    throw new BadRequestException('sortOrder is invalid');
  }

  private getListCacheKey(query: object) {
    const params = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([left], [right]) => left.localeCompare(right));
    return `audit:${JSON.stringify(params)}`;
  }
}
