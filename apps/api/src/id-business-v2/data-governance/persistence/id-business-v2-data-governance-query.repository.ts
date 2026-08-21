import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { isV2MysqlDatabase, type V2CommandTransaction } from '../../runtime/public-api';
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

interface CleanupPreviewRow {
  id: string;
  status: string;
  startedAt: Date;
  snapshotId: string | null;
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

  async overviewRows(requesterUserId: string) {
    const [counts, accounts, customers, options, orders, latestRetentionAudit, approvalReadiness] =
      await Promise.all([
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
        }),
        this.approvalReadiness(requesterUserId)
      ]);
    return {
      counts,
      accounts,
      customers,
      options,
      orders,
      latestRetentionAudit,
      approvalReadiness
    };
  }

  async approvalReadiness(requesterUserId: string, tx?: V2CommandTransaction) {
    const database = tx ?? this.prisma;
    const activeAdminWhere = {
      status: 'active' as const,
      deletedAt: null,
      v2AuthIdentity: { is: { enabled: true } },
      userRoles: { some: { role: { code: 'admin' } } }
    } satisfies Prisma.UserWhereInput;
    const [activeAdminCount, eligibleApproverCount] = await Promise.all([
      database.user.count({ where: activeAdminWhere }),
      database.user.count({
        where: {
          ...activeAdminWhere,
          id: { not: requesterUserId }
        }
      })
    ]);
    return { activeAdminCount, eligibleApproverCount };
  }

  async recycleBinRows(input: { entity: RecycleEntity | null; skip: number; take: number }) {
    const entityFilter = input.entity ?? '';
    const [rows, counts] = await Promise.all([
      this.prisma.$queryRaw<RecycleRow[]>(Prisma.sql`
        SELECT recycled.id, recycled.entity, recycled.label, recycled.deleted_at
        FROM (
          SELECT id, 'account' AS entity, apple_id_masked AS label, deleted_at
          FROM id_business_v2_accounts WHERE deleted_at IS NOT NULL
          UNION ALL
          SELECT id, 'customer' AS entity, name AS label, deleted_at
          FROM id_business_v2_customers WHERE deleted_at IS NOT NULL
          UNION ALL
          SELECT id, 'option' AS entity, name AS label, deleted_at
          FROM id_business_v2_options WHERE deleted_at IS NOT NULL
          UNION ALL
          SELECT id, 'order' AS entity, order_no AS label, deleted_at
          FROM id_business_v2_orders WHERE deleted_at IS NOT NULL
        ) recycled
        WHERE (${entityFilter} = '' OR recycled.entity = ${entityFilter})
        ORDER BY recycled.deleted_at DESC, recycled.id DESC
        LIMIT ${input.take}
        OFFSET ${input.skip}
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
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          uniqueKey: true,
          deletedAt: true,
          parentId: true,
          countryOptionId: true,
          statusBeforeDeletion: true
        }
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

  findDependentServicesForRestore(parent: {
    id: string;
    type: 'country' | 'business_category';
    deletedAt: Date;
  }) {
    return this.prisma.idBusinessV2Option.findMany({
      where: {
        type: 'service',
        deletedAt: parent.deletedAt,
        deletedByParentOptionId: parent.id,
        ...(parent.type === 'country' ? { countryOptionId: parent.id } : { parentId: parent.id })
      },
      select: {
        id: true,
        uniqueKey: true,
        statusBeforeDeletion: true,
        deletedByParentOptionId: true
      },
      orderBy: { id: 'asc' }
    });
  }

  async cleanupPreviewRows(cutoff: Date, take: number) {
    if (isV2MysqlDatabase()) return this.cleanupPreviewRowsMysql(cutoff, take);

    const eligibleWhere = Prisma.sql`
      run."status" <> 'running'
      AND run."started_at" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1
        FROM "id_business_v2_gift_cards" gift_card
        WHERE gift_card."exchange_rate_snapshot_id" = snapshot."id"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "id_business_v2_finance_fx_rate_snapshots" fx_snapshot
        WHERE fx_snapshot."source" = 'combined_p2p'
          AND fx_snapshot."source_reference" = CAST(snapshot."id" AS VARCHAR(36))
      )
    `;
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<CleanupPreviewRow[]>(Prisma.sql`
        SELECT
          run."id",
          run."status" AS "status",
          run."started_at" AS "startedAt",
          snapshot."id" AS "snapshotId"
        FROM "id_business_v2_exchange_rate_runs" run
        LEFT JOIN "id_business_v2_exchange_rate_snapshots" snapshot
          ON snapshot."run_id" = run."id"
        WHERE ${eligibleWhere}
        ORDER BY run."started_at" ASC, run."id" ASC
        LIMIT ${take}
      `),
      this.prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS "total"
        FROM "id_business_v2_exchange_rate_runs" run
        LEFT JOIN "id_business_v2_exchange_rate_snapshots" snapshot
          ON snapshot."run_id" = run."id"
        WHERE ${eligibleWhere}
      `)
    ]);
    return {
      runs: rows.map((row) => ({
        id: row.id,
        status: row.status,
        startedAt: row.startedAt,
        snapshot: row.snapshotId
          ? { id: row.snapshotId, _count: { giftCards: 0 }, financeReferenceCount: 0 }
          : null
      })),
      eligibleTotal: Number(totals[0]?.total ?? 0)
    };
  }

  private async cleanupPreviewRowsMysql(cutoff: Date, take: number) {
    const eligibleWhere = Prisma.sql`
      run.\`status\` <> 'running'
      AND run.\`started_at\` < ${cutoff}
      AND NOT EXISTS (
        SELECT 1
        FROM \`id_business_v2_gift_cards\` gift_card
        WHERE gift_card.\`exchange_rate_snapshot_id\` = snapshot.\`id\`
      )
      AND NOT EXISTS (
        SELECT 1
        FROM \`id_business_v2_finance_fx_rate_snapshots\` fx_snapshot
        WHERE fx_snapshot.\`source\` = 'combined_p2p'
          AND fx_snapshot.\`source_reference\` = CAST(snapshot.\`id\` AS CHAR(36))
      )
    `;
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<CleanupPreviewRow[]>(Prisma.sql`
        SELECT
          run.\`id\`,
          run.\`status\` AS \`status\`,
          run.\`started_at\` AS \`startedAt\`,
          snapshot.\`id\` AS \`snapshotId\`
        FROM \`id_business_v2_exchange_rate_runs\` run
        LEFT JOIN \`id_business_v2_exchange_rate_snapshots\` snapshot
          ON snapshot.\`run_id\` = run.\`id\`
        WHERE ${eligibleWhere}
        ORDER BY run.\`started_at\` ASC, run.\`id\` ASC
        LIMIT ${take}
      `),
      this.prisma.$queryRaw<Array<{ total: number | bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS \`total\`
        FROM \`id_business_v2_exchange_rate_runs\` run
        LEFT JOIN \`id_business_v2_exchange_rate_snapshots\` snapshot
          ON snapshot.\`run_id\` = run.\`id\`
        WHERE ${eligibleWhere}
      `)
    ]);
    return {
      runs: rows.map((row) => ({
        id: row.id,
        status: row.status,
        startedAt: row.startedAt,
        snapshot: row.snapshotId
          ? { id: row.snapshotId, _count: { giftCards: 0 }, financeReferenceCount: 0 }
          : null
      })),
      eligibleTotal: Number(totals[0]?.total ?? 0)
    };
  }

  async exchangeRateRetentionDays() {
    const settings = await this.prisma.idBusinessV2ExchangeRateSettings.findUnique({
      where: { id: 1 },
      select: { retentionDays: true }
    });
    return settings?.retentionDays ?? 30;
  }
}
