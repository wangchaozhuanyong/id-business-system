import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import {
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../../runtime/public-api';
import { V2CommandTransactionManager } from '../../runtime/public-api';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import type { OnlineRechargeSection } from '../contracts';
import { integer, redact, sanitize } from '../validation';

@Injectable()
export class OnlineRechargeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: V2TransactionalAuditService,
    private readonly transactions: V2CommandTransactionManager
  ) {}
  read<T>(work: (db: PrismaService) => Promise<T>) {
    return work(this.prisma);
  }
  transaction<T>(key: string, work: (tx: V2CommandTransaction) => Promise<T>) {
    return this.transactions.execute(
      async (tx) => {
        await acquireMysqlTransactionLock(tx, `online-recharge:${key}`);
        return work(tx);
      },
      {
        changedScopes: ['online-recharge'],
        requestId: randomUUID(),
        isolationLevel: 'Serializable',
        timeoutMs: 20000,
        retryMode: 'none'
      }
    );
  }
  log(
    tx: V2CommandTransaction,
    action: string,
    operator?: AuthenticatedUser,
    objectId?: string,
    details: unknown = {}
  ) {
    return this.audit.append(tx, {
      userId: operator?.id,
      module: 'online_recharge',
      action: `id_business_v2.online_recharge.${action}`.slice(0, 100),
      objectType: 'online_recharge',
      objectId,
      afterData: toV2JsonDocument(sanitize(details)),
      remark: '线上代充受控操作'
    });
  }
  async list(section: OnlineRechargeSection, query: Record<string, unknown>) {
    const page = integer(query.page ?? 1, '页码', 1, 1000000);
    const pageSize = integer(query.pageSize ?? 20, '每页数量', 1, 100);
    const keyword = String(query.keyword ?? query.search ?? '')
      .trim()
      .slice(0, 100);
    const options = { skip: (page - 1) * pageSize, take: pageSize };
    const order: 'asc' | 'desc' = query.sortOrder === 'asc' ? 'asc' : 'desc';
    const taskWhere: Prisma.OnlineRechargeTaskWhereInput = {
      deletedAt: null,
      ...(query.status
        ? { status: String(query.status) as Prisma.EnumOnlineRechargeStatusFilter }
        : {}),
      ...(query.plan ? { plan: String(query.plan) as Prisma.EnumOnlineRechargePlanFilter } : {}),
      ...(keyword
        ? {
            OR: [
              { id: { contains: keyword } },
              { message: { contains: keyword } },
              { cardLast4: { contains: keyword } }
            ]
          }
        : {})
    };
    return this.read(async (db) => {
      let items: unknown[], total: number;
      switch (section) {
        case 'cards': {
          const where: Prisma.OnlineRechargeCardWhereInput = {
            ...(query.status
              ? { status: String(query.status) as Prisma.EnumOnlineRechargeAssetStatusFilter }
              : {}),
            ...(keyword
              ? { OR: [{ last4: { contains: keyword } }, { holderName: { contains: keyword } }] }
              : {})
          };
          [items, total] = await Promise.all([
            db.onlineRechargeCard.findMany({ where, ...options, orderBy: { createdAt: order } }),
            db.onlineRechargeCard.count({ where })
          ]);
          break;
        }
        case 'proxies': {
          const where: Prisma.OnlineRechargeProxyWhereInput = {
            ...(keyword ? { displayHost: { contains: keyword } } : {}),
            ...(query.status
              ? { status: String(query.status) as Prisma.EnumOnlineRechargeAssetStatusFilter }
              : {})
          };
          [items, total] = await Promise.all([
            db.onlineRechargeProxy.findMany({ where, ...options, orderBy: { createdAt: order } }),
            db.onlineRechargeProxy.count({ where })
          ]);
          break;
        }
        case 'addresses': {
          const where = {
            active: true,
            ...(query.region ? { region: String(query.region) } : {}),
            ...(query.country ? { country: String(query.country) } : {}),
            ...(query.status === 'bound'
              ? { successCount: { gt: 0 } }
              : query.status === 'unbound'
                ? { successCount: 0 }
                : {}),
            ...(keyword
              ? { OR: [{ street: { contains: keyword } }, { city: { contains: keyword } }] }
              : {})
          };
          [items, total] = await Promise.all([
            db.onlineRechargeAddress.findMany({ where, ...options, orderBy: { createdAt: order } }),
            db.onlineRechargeAddress.count({ where })
          ]);
          break;
        }
        case 'cdks': {
          const where: Prisma.OnlineRechargeCodeWhereInput = {
            deletedAt: null,
            ...(query.status
              ? { status: String(query.status) as Prisma.EnumOnlineRechargeCodeStatusFilter }
              : {}),
            ...(query.plan
              ? { plan: String(query.plan) as Prisma.EnumOnlineRechargePlanFilter }
              : {}),
            ...(query.dispatched === 'true' || query.dispatched === 'false'
              ? { dispatched: query.dispatched === 'true' }
              : {}),
            ...(keyword ? { codeLast4: { contains: keyword } } : {})
          };
          [items, total] = await Promise.all([
            db.onlineRechargeCode.findMany({ where, ...options, orderBy: { createdAt: order } }),
            db.onlineRechargeCode.count({ where })
          ]);
          break;
        }
        case 'billing': {
          const from = query.createdFrom ?? query.startDate,
            to = query.createdTo ?? query.endDate;
          const date = (value: unknown, end: boolean) => {
            const source = String(value);
            return new Date(
              /^\d{4}-\d{2}-\d{2}$/.test(source)
                ? `${source}T${end ? '23:59:59.999' : '00:00:00.000'}+08:00`
                : source
            );
          };
          const where: Prisma.OnlineRechargeBillWhereInput = {
            ...(query.status ? { status: String(query.status) } : {}),
            ...(query.plan
              ? { plan: String(query.plan) as Prisma.EnumOnlineRechargePlanFilter }
              : {}),
            ...(query.cardLast4 ? { cardLast4: String(query.cardLast4) } : {}),
            ...(keyword ? { cardLast4: { contains: keyword } } : {}),
            ...(from || to
              ? {
                  createdAt: {
                    ...(from ? { gte: date(from, false) } : {}),
                    ...(to ? { lte: date(to, true) } : {})
                  }
                }
              : {})
          };
          [items, total] = await Promise.all([
            db.onlineRechargeBill.findMany({ where, ...options, orderBy: { createdAt: order } }),
            db.onlineRechargeBill.count({ where })
          ]);
          break;
        }
        case 'runtime-logs': {
          const reset = await db.onlineRechargeEvent.findFirst({
            where: { stage: 'runtime_clear' },
            orderBy: { createdAt: 'desc' }
          });
          const where = {
            ...(reset ? { createdAt: { gt: reset.createdAt } } : {}),
            ...(query.taskId ? { taskId: String(query.taskId) } : {}),
            ...(keyword ? { message: { contains: keyword } } : {})
          };
          [items, total] = await Promise.all([
            db.onlineRechargeEvent.findMany({ where, ...options, orderBy: { createdAt: order } }),
            db.onlineRechargeEvent.count({ where })
          ]);
          break;
        }
        case 'login-logs': {
          const where = keyword ? { username: { contains: keyword } } : {};
          [items, total] = await Promise.all([
            db.loginLog.findMany({ where, ...options, orderBy: { createdAt: order } }),
            db.loginLog.count({ where })
          ]);
          break;
        }
        case 'sessions':
        case 'renewal':
        case 'jobs':
        case 'automation': {
          const where: Prisma.OnlineRechargeTaskWhereInput =
            section === 'sessions'
              ? { ...taskWhere, sessionEncrypted: { not: null } }
              : section === 'renewal'
                ? {
                    ...taskWhere,
                    sessionEncrypted: { not: null },
                    AND: [
                      {
                        OR: [
                          { operation: 'recharge', status: 'succeeded' },
                          { operation: { in: ['subscription', 'renewal'] } }
                        ]
                      }
                    ]
                  }
                : taskWhere;
          [items, total] = await Promise.all([
            db.onlineRechargeTask.findMany({ where, ...options, orderBy: { createdAt: order } }),
            db.onlineRechargeTask.count({ where })
          ]);
          break;
        }
        default:
          items = [];
          total = 0;
      }
      return { items, total, page, pageSize };
    });
  }
  async event(taskId: string | undefined, message: string, stage?: string, metadata?: unknown) {
    return this.read((db) =>
      db.onlineRechargeEvent.create({
        data: {
          taskId,
          stage,
          message: redact(message).slice(0, 12000),
          metadata: sanitize(metadata ?? {}) as Prisma.InputJsonValue
        }
      })
    );
  }
}
