import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type {
  GovernanceJobStatus,
  GovernanceJobType,
  RecycleEntity
} from '../data-governance.types';

interface RecycleRow {
  id: string;
  entity: RecycleEntity;
  label: string;
  deleted_at: Date;
}

const GOVERNANCE_USER_SELECT = {
  id: true,
  username: true,
  displayName: true
} satisfies Prisma.UserSelect;

const GOVERNANCE_JOB_LIST_INCLUDE = {
  requestedBy: { select: GOVERNANCE_USER_SELECT },
  executedBy: { select: GOVERNANCE_USER_SELECT },
  approval: { include: { approver: { select: GOVERNANCE_USER_SELECT } } }
} satisfies Prisma.IdBusinessV2GovernanceJobInclude;

@Injectable()
export class IdBusinessV2DataGovernanceQueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async overviewRows() {
    const [counts, accounts, customers, options, orders, latestRetentionAudit] = await Promise.all([
      this.recycleCounts(),
      this.prisma.idBusinessV2Account.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, appleIdMasked: true, deletedAt: true },
        orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
        take: 20
      }),
      this.prisma.idBusinessV2Customer.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, name: true, deletedAt: true },
        orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
        take: 20
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, name: true, deletedAt: true },
        orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
        take: 20
      }),
      this.prisma.idBusinessV2Order.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, orderNo: true, deletedAt: true },
        orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
        take: 20
      }),
      this.prisma.auditLog.findFirst({
        where: { action: 'id_business_v2.exchange_rate.retention_cleanup' },
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      })
    ]);
    return { counts, accounts, customers, options, orders, latestRetentionAudit };
  }

  async recycleBinRows(input: { entity: RecycleEntity | null; skip: number; take: number }) {
    const entityFilter = input.entity ?? '';
    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<RecycleRow[]>(Prisma.sql`
        SELECT recycled.id, recycled.entity, recycled.label, recycled.deleted_at
        FROM (
          SELECT id, 'account'::text AS entity, apple_id_masked AS label, deleted_at
          FROM id_business_v2_accounts WHERE deleted_at IS NOT NULL
          UNION ALL
          SELECT id, 'customer'::text AS entity, name AS label, deleted_at
          FROM id_business_v2_customers WHERE deleted_at IS NOT NULL
          UNION ALL
          SELECT id, 'option'::text AS entity, name AS label, deleted_at
          FROM id_business_v2_options WHERE deleted_at IS NOT NULL
          UNION ALL
          SELECT id, 'order'::text AS entity, order_no AS label, deleted_at
          FROM id_business_v2_orders WHERE deleted_at IS NOT NULL
        ) recycled
        WHERE (${entityFilter} = '' OR recycled.entity = ${entityFilter})
        ORDER BY recycled.deleted_at DESC, recycled.id DESC
        OFFSET ${input.skip}
        LIMIT ${input.take}
      `),
      this.recycleCounts()
    ]);
    return { rows, counts };
  }

  async recycleCounts() {
    const [account, customer, option, order] = await Promise.all([
      this.prisma.idBusinessV2Account.count({ where: { deletedAt: { not: null } } }),
      this.prisma.idBusinessV2Customer.count({ where: { deletedAt: { not: null } } }),
      this.prisma.idBusinessV2Option.count({ where: { deletedAt: { not: null } } }),
      this.prisma.idBusinessV2Order.count({ where: { deletedAt: { not: null } } })
    ]);
    return { account, customer, option, order };
  }

  async listJobs(input: {
    type: GovernanceJobType | null;
    status: GovernanceJobStatus | null;
    skip: number;
    take: number;
  }) {
    const where: Prisma.IdBusinessV2GovernanceJobWhereInput = {
      ...(input.type ? { type: input.type } : {}),
      ...(input.status ? { status: input.status } : {})
    };
    const [items, total] = await Promise.all([
      this.prisma.idBusinessV2GovernanceJob.findMany({
        where,
        skip: input.skip,
        take: input.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: GOVERNANCE_JOB_LIST_INCLUDE
      }),
      this.prisma.idBusinessV2GovernanceJob.count({ where })
    ]);
    return { items, total };
  }

  findJob(id: string) {
    return this.prisma.idBusinessV2GovernanceJob.findUnique({
      where: { id },
      include: {
        ...GOVERNANCE_JOB_LIST_INCLUDE,
        items: { orderBy: [{ sequence: 'asc' }, { id: 'asc' }] },
        checkpoints: { orderBy: [{ batchNo: 'asc' }, { id: 'asc' }] }
      }
    });
  }

  async restorePreviewSources(ids: Record<RecycleEntity, string[]>) {
    const [accounts, customers, options, orders] = await Promise.all([
      this.prisma.idBusinessV2Account.findMany({
        where: { id: { in: ids.account } },
        select: {
          id: true,
          appleIdMasked: true,
          deletedAt: true,
          lossReportedAt: true,
          soldByOrderId: true
        }
      }),
      this.prisma.idBusinessV2Customer.findMany({
        where: { id: { in: ids.customer } },
        select: { id: true, name: true, deletedAt: true }
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: { id: { in: ids.option } },
        select: { id: true, name: true, uniqueKey: true, deletedAt: true }
      }),
      this.prisma.idBusinessV2Order.findMany({
        where: { id: { in: ids.order } },
        select: { id: true, orderNo: true, status: true, deletedAt: true }
      })
    ]);
    return { accounts, customers, options, orders };
  }

  findOptionUniqueKeys(uniqueKeys: string[]) {
    return this.prisma.idBusinessV2Option.findMany({
      where: { uniqueKey: { in: uniqueKeys } },
      select: { id: true, uniqueKey: true }
    });
  }

  async cleanupPreviewRows(cutoff: Date, take: number) {
    const where: Prisma.IdBusinessV2ExchangeRateRunWhereInput = {
      status: { not: 'running' },
      startedAt: { lt: cutoff },
      OR: [{ snapshot: { is: null } }, { snapshot: { is: { giftCards: { none: {} } } } }]
    };
    const [runs, eligibleTotal] = await Promise.all([
      this.prisma.idBusinessV2ExchangeRateRun.findMany({
        where,
        select: {
          id: true,
          status: true,
          startedAt: true,
          snapshot: { select: { id: true, _count: { select: { giftCards: true } } } }
        },
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        take
      }),
      this.prisma.idBusinessV2ExchangeRateRun.count({ where })
    ]);
    return { runs, eligibleTotal };
  }
}
