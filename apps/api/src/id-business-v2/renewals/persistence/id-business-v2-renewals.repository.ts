import { Injectable } from '@nestjs/common';
import type { IdBusinessV2BalanceLedger, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  mapAmount4,
  mapOptionalAmount4,
  mapRate8,
  type Amount4,
  type V2CommandTransaction
} from '../../runtime/public-api';
import type {
  ManualRenewalReplayOrder,
  ManualRenewalLedgerRecord,
  RenewalBaseCriteria,
  RenewalDueFilter,
  RenewalRecord
} from '../id-business-v2-renewal.types';

const DAY_MS = 24 * 60 * 60 * 1000;

const RENEWAL_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNo: true,
      websiteAccountEncrypted: true,
      websiteAccountMasked: true,
      displaySnapshot: true
    }
  },
  customer: { select: { id: true, name: true } },
  account: {
    select: {
      id: true,
      appleIdEncrypted: true,
      appleIdMasked: true,
      currentBalance: true,
      balanceCostAmount: true,
      recordStatus: true,
      soldByOrderId: true,
      soldByOrder: {
        select: {
          id: true,
          orderNo: true,
          customer: { select: { id: true, name: true } }
        }
      },
      countryOption: { select: { id: true, code: true, name: true } }
    }
  },
  serviceOption: {
    select: {
      id: true,
      code: true,
      name: true,
      parent: { select: { id: true, name: true } }
    }
  }
} satisfies Prisma.IdBusinessV2ActivationInclude;

const MANUAL_RENEWAL_REPLAY_INCLUDE = {
  activation: true,
  balanceLedger: {
    where: { entryType: 'order_consumption' as const },
    take: 1,
    orderBy: { createdAt: 'asc' as const }
  }
} satisfies Prisma.IdBusinessV2OrderInclude;

type RenewalPersistenceRow = Prisma.IdBusinessV2ActivationGetPayload<{
  include: typeof RENEWAL_INCLUDE;
}>;
type ManualRenewalReplayPersistenceRow = Prisma.IdBusinessV2OrderGetPayload<{
  include: typeof MANUAL_RENEWAL_REPLAY_INCLUDE;
}>;

interface LockedManualRenewalAccountPersistenceRow {
  id: string;
  currentBalance: unknown;
  balanceCostAmount: unknown;
  purchaseCost: unknown;
  soldByOrderId: string | null;
  soldByCustomerId: string | null;
  lossReportedAt: Date | null;
}

export interface LockedManualRenewalAccountRow extends Omit<
  LockedManualRenewalAccountPersistenceRow,
  'currentBalance' | 'balanceCostAmount' | 'purchaseCost'
> {
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  purchaseCost: Amount4;
}

@Injectable()
export class IdBusinessV2RenewalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  appendAudit(tx: V2CommandTransaction, data: Prisma.AuditLogUncheckedCreateInput) {
    return tx.auditLog.create({ data });
  }

  getWarningSettingInTransaction(tx: V2CommandTransaction, scope: string) {
    return tx.idBusinessV2RenewalWarningSetting.findUnique({
      where: { scope },
      select: { id: true, warningDays: true }
    });
  }

  upsertWarningSetting(
    tx: V2CommandTransaction,
    input: { scope: string; warningDays: number; updatedByUserId: string }
  ) {
    return tx.idBusinessV2RenewalWarningSetting.upsert({
      where: { scope: input.scope },
      create: input,
      update: {
        warningDays: input.warningDays,
        updatedByUserId: input.updatedByUserId
      }
    });
  }

  async createManualRenewalLedger(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2BalanceLedgerUncheckedCreateInput
  ) {
    const row = await tx.idBusinessV2BalanceLedger.create({ data });
    return mapManualRenewalLedger(row);
  }

  updateManualRenewalAccount(
    tx: V2CommandTransaction,
    accountId: string,
    data: Prisma.IdBusinessV2AccountUncheckedUpdateInput
  ) {
    return tx.idBusinessV2Account.update({ where: { id: accountId }, data });
  }

  updateManualRenewalOrder(
    tx: V2CommandTransaction,
    orderId: string,
    data: Prisma.IdBusinessV2OrderUncheckedUpdateInput
  ) {
    return tx.idBusinessV2Order.update({ where: { id: orderId }, data });
  }

  createManualRenewalActivation(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2ActivationUncheckedCreateInput
  ) {
    return tx.idBusinessV2Activation.create({ data });
  }

  async getWarningSetting(scope: string) {
    return this.prisma.idBusinessV2RenewalWarningSetting.findUnique({
      where: { scope },
      select: { warningDays: true, updatedAt: true }
    });
  }

  async getWarningCounts(base: RenewalBaseCriteria, now: Date, warningDays: number) {
    const baseWhere = this.buildBaseWhere(base);
    const [upcomingCount, expiredCount] = await Promise.all([
      this.prisma.idBusinessV2Activation.count({
        where: { AND: [baseWhere, this.buildWarningWhere(now, warningDays)] }
      }),
      this.prisma.idBusinessV2Activation.count({
        where: { AND: [baseWhere, this.buildExpiredWhere(now)] }
      })
    ]);
    return {
      upcomingCount,
      expiredCount,
      totalCount: upcomingCount + expiredCount
    };
  }

  async getWarningSummary(now: Date, warningDays: number) {
    const summarySelect = {
      id: true,
      dueAt: true,
      status: true,
      order: { select: { displaySnapshot: true } },
      customer: { select: { id: true, name: true } },
      account: { select: { id: true, appleIdEncrypted: true, appleIdMasked: true } },
      serviceOption: { select: { id: true, name: true } }
    } satisfies Prisma.IdBusinessV2ActivationSelect;
    const [upcoming, expired, nextTimedActivation] = await Promise.all([
      this.prisma.idBusinessV2Activation.findMany({
        where: this.buildWarningWhere(now, warningDays),
        select: summarySelect,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: 5
      }),
      this.prisma.idBusinessV2Activation.findMany({
        where: this.buildExpiredWhere(now),
        select: summarySelect,
        orderBy: [{ dueAt: 'desc' }, { id: 'asc' }],
        take: 5
      }),
      this.prisma.idBusinessV2Activation.findFirst({
        where: {
          renewedBy: { is: null },
          status: 'active',
          dueAt: { gt: now },
          account: { is: { recordStatus: 'active', lossReportedAt: null } }
        },
        select: { dueAt: true },
        orderBy: { dueAt: 'asc' }
      })
    ]);
    return {
      upcoming: upcoming.map(mapRenewalWarningSummaryRow),
      expired: expired.map(mapRenewalWarningSummaryRow),
      nextTimedDueAt: nextTimedActivation?.dueAt ?? null
    };
  }

  async listWorkbench(criteria: {
    base: RenewalBaseCriteria;
    dueFilter: RenewalDueFilter;
    sortField: string;
    sortDirection: 'asc' | 'desc';
    skip: number;
    take: number;
  }) {
    const baseWhere = this.buildBaseWhere(criteria.base);
    const where: Prisma.IdBusinessV2ActivationWhereInput = {
      AND: [baseWhere, this.buildDueFilter(criteria.dueFilter)]
    };
    const [rows, total, nextTimedActivation] = await Promise.all([
      this.prisma.idBusinessV2Activation.findMany({
        where,
        include: RENEWAL_INCLUDE,
        skip: criteria.skip,
        take: criteria.take,
        orderBy: this.buildWorkbenchOrderBy(criteria.sortField, criteria.sortDirection)
      }),
      this.prisma.idBusinessV2Activation.count({ where }),
      this.prisma.idBusinessV2Activation.findFirst({
        where: {
          AND: [baseWhere, { renewedBy: { is: null }, status: 'active', dueAt: { gt: new Date() } }]
        },
        select: { dueAt: true },
        orderBy: { dueAt: 'asc' }
      })
    ]);
    return {
      items: rows.map(mapRenewalRecord),
      total,
      nextTimedDueAt: nextTimedActivation?.dueAt ?? null
    };
  }

  async listFilterOptions() {
    const actionableWhere = this.buildDueFilter({ kind: 'all_due' });
    const [customers, accounts, services] = await Promise.all([
      this.prisma.idBusinessV2Customer.findMany({
        where: { activations: { some: actionableWhere } },
        select: { id: true, name: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Account.findMany({
        where: {
          recordStatus: 'active',
          lossReportedAt: null,
          activations: { some: actionableWhere }
        },
        select: { id: true, appleIdEncrypted: true, appleIdMasked: true },
        orderBy: [{ appleIdMasked: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: { type: 'service', activationsByService: { some: actionableWhere } },
        select: {
          id: true,
          code: true,
          name: true,
          parent: { select: { id: true, name: true } }
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
    ]);
    return { customers, accounts, services };
  }

  async listManualRenewalOptions() {
    const [settlementPlatforms, services] = await Promise.all([
      this.prisma.idBusinessV2Option.findMany({
        where: { type: 'settlement_platform', status: 'active', deletedAt: null },
        select: {
          id: true,
          code: true,
          name: true,
          fixedFee: true,
          percentageFee: true
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Option.findMany({
        where: {
          type: 'service',
          status: 'active',
          deletedAt: null,
          businessAmount: { gt: 0 },
          parent: { is: { type: 'business_category', status: 'active', deletedAt: null } },
          countryOption: { is: { type: 'country', status: 'active', deletedAt: null } }
        },
        select: {
          id: true,
          code: true,
          name: true,
          businessAmount: true,
          parent: { select: { id: true, name: true } },
          countryOption: { select: { id: true, code: true, name: true, currencyCode: true } }
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
    ]);
    return {
      settlementPlatforms: settlementPlatforms.map((platform) => ({
        ...platform,
        fixedFee: mapAmount4(platform.fixedFee, 'id_business_v2_options.fixed_fee').toString(),
        percentageFee: mapRate8(
          platform.percentageFee,
          'id_business_v2_options.percentage_fee'
        ).toString()
      })),
      services: services.map((service) => ({
        id: service.id,
        code: service.code,
        name: service.name,
        category: service.parent,
        country: service.countryOption,
        businessAmount:
          service.businessAmount === null
            ? '0'
            : mapAmount4(
                service.businessAmount,
                'id_business_v2_options.business_amount'
              ).toString(),
        currencyCode: service.countryOption?.currencyCode ?? null
      }))
    };
  }

  async findManualRenewalReplay(tx: V2CommandTransaction, idempotencyKey: string) {
    const row = await tx.idBusinessV2Order.findUnique({
      where: { idempotencyKey },
      include: MANUAL_RENEWAL_REPLAY_INCLUDE
    });
    return row ? mapManualRenewalReplay(row) : null;
  }

  async findManualRenewalSourceActivation(
    tx: V2CommandTransaction,
    activationId: string,
    evaluatedAt: Date
  ) {
    return tx.idBusinessV2Activation.findFirst({
      where: {
        id: activationId,
        renewedBy: { is: null },
        OR: [
          { status: 'expired' },
          {
            status: 'active',
            dueAt: { not: null, lte: new Date(evaluatedAt.getTime() + 7 * DAY_MS) }
          }
        ]
      },
      select: {
        id: true,
        orderId: true,
        customerId: true,
        accountId: true,
        dueAt: true,
        order: {
          select: {
            status: true,
            deletedAt: true,
            websiteAccountEncrypted: true,
            websiteAccountHash: true,
            websiteAccountMasked: true,
            websiteAccountSearchTokens: true
          }
        },
        account: {
          select: {
            appleIdMasked: true,
            recordStatus: true,
            deletedAt: true,
            lossReportedAt: true,
            soldByOrderId: true,
            soldByOrder: { select: { customerId: true } },
            countryOption: { select: { id: true, code: true, name: true } },
            statusOption: { select: { code: true, status: true, deletedAt: true } }
          }
        }
      }
    });
  }

  async findManualRenewalService(tx: V2CommandTransaction, serviceOptionId: string) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        id: serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null,
        businessAmount: { gt: 0 },
        parent: { is: { type: 'business_category', status: 'active', deletedAt: null } },
        countryOption: { is: { type: 'country', status: 'active', deletedAt: null } }
      },
      select: {
        id: true,
        countryOption: { select: { id: true, code: true, name: true } }
      }
    });
  }

  async findManualRenewalConflicts(
    tx: V2CommandTransaction,
    input: {
      sourceOrderId: string;
      accountId: string;
      serviceOptionId: string;
      openedAt: Date;
      dueAt: Date;
      evaluatedAt: Date;
    }
  ) {
    const [activeOrderLock, duplicateRenewalOrder] = await Promise.all([
      tx.idBusinessV2AccountLock.findFirst({
        where: {
          accountId: input.accountId,
          status: 'active',
          expiresAt: { gt: input.evaluatedAt },
          order: {
            is: {
              status: { in: ['draft', 'pending', 'waiting_external', 'processing'] },
              deletedAt: null
            }
          }
        },
        select: { id: true }
      }),
      tx.idBusinessV2Order.findFirst({
        where: {
          id: { not: input.sourceOrderId },
          accountId: input.accountId,
          serviceOptionId: input.serviceOptionId,
          openedAt: input.openedAt,
          dueAt: input.dueAt,
          status: 'completed',
          deletedAt: null,
          activation: {
            is: {
              accountId: input.accountId,
              serviceOptionId: input.serviceOptionId,
              openedAt: input.openedAt,
              dueAt: input.dueAt
            }
          }
        },
        select: { id: true, orderNo: true }
      })
    ]);
    return { activeOrderLock, duplicateRenewalOrder };
  }

  async lockActivation(tx: V2CommandTransaction, activationId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "id_business_v2_activations"
      WHERE "id" = CAST(${activationId} AS UUID)
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async lockAccount(
    tx: V2CommandTransaction,
    accountId: string
  ): Promise<LockedManualRenewalAccountRow | null> {
    const rows = await tx.$queryRaw<LockedManualRenewalAccountPersistenceRow[]>`
      SELECT
        account."id",
        account."current_balance" AS "currentBalance",
        account."balance_cost_amount" AS "balanceCostAmount",
        account."purchase_cost" AS "purchaseCost",
        account."sold_by_order_id" AS "soldByOrderId",
        sold_order."customer_id" AS "soldByCustomerId",
        account."loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts" account
      LEFT JOIN "id_business_v2_orders" sold_order
        ON sold_order."id" = account."sold_by_order_id"
        AND sold_order."deleted_at" IS NULL
      WHERE
        account."id" = CAST(${accountId} AS UUID)
        AND account."record_status" = 'active'
        AND account."deleted_at" IS NULL
        AND account."loss_reported_at" IS NULL
      FOR UPDATE OF account
    `;
    const account = rows[0];
    return account
      ? {
          ...account,
          currentBalance: mapAmount4(
            account.currentBalance,
            'id_business_v2_accounts.current_balance'
          ),
          balanceCostAmount: mapAmount4(
            account.balanceCostAmount,
            'id_business_v2_accounts.balance_cost_amount'
          ),
          purchaseCost: mapAmount4(account.purchaseCost, 'id_business_v2_accounts.purchase_cost')
        }
      : null;
  }

  private buildBaseWhere(criteria: RenewalBaseCriteria): Prisma.IdBusinessV2ActivationWhereInput {
    return {
      customerId: criteria.customerId ?? undefined,
      serviceOptionId: criteria.serviceOptionId ?? undefined,
      accountId: criteria.accountId ?? undefined,
      account: criteria.requireAvailableAccount ? { is: { soldByOrderId: null } } : undefined,
      OR: criteria.keyword
        ? [
            { order: { is: { orderNo: { contains: criteria.keyword, mode: 'insensitive' } } } },
            { customer: { is: { name: { contains: criteria.keyword, mode: 'insensitive' } } } },
            {
              serviceOption: {
                is: { name: { contains: criteria.keyword, mode: 'insensitive' } }
              }
            },
            {
              account: {
                is: { appleIdMasked: { contains: criteria.keyword, mode: 'insensitive' } }
              }
            },
            {
              order: {
                is: {
                  websiteAccountMasked: { contains: criteria.keyword, mode: 'insensitive' }
                }
              }
            },
            {
              order: {
                is: {
                  displaySnapshot: {
                    is: {
                      OR: [
                        { customerName: { contains: criteria.keyword, mode: 'insensitive' } },
                        { serviceName: { contains: criteria.keyword, mode: 'insensitive' } },
                        { accountLabel: { contains: criteria.keyword, mode: 'insensitive' } }
                      ]
                    }
                  }
                }
              }
            }
          ]
        : undefined
    };
  }

  private buildDueFilter(filter: RenewalDueFilter): Prisma.IdBusinessV2ActivationWhereInput {
    if (filter.kind === 'all_due') {
      return {
        renewedBy: { is: null },
        OR: [{ status: 'expired' }, { status: 'active', dueAt: { not: null } }]
      };
    }
    if (filter.kind === 'date_range') {
      return {
        AND: [this.buildDueFilter(filter.base ?? { kind: 'all_due' }), { dueAt: filter.dueAt }]
      };
    }
    if (filter.kind === 'warning') {
      return this.buildWarningWhere(filter.evaluatedAt, filter.warningDays);
    }
    if (filter.kind === 'default') {
      return {
        renewedBy: { is: null },
        OR: [
          { status: 'expired' },
          {
            status: 'active',
            dueAt: {
              not: null,
              lte: new Date(filter.evaluatedAt.getTime() + filter.warningDays * DAY_MS)
            }
          }
        ]
      };
    }
    const now = filter.evaluatedAt;
    if (filter.status === 'expired') return this.buildExpiredWhere(now);
    const oneHour = new Date(now.getTime() + 60 * 60 * 1000);
    const twentyThreeHours = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const sevenDays = new Date(now.getTime() + 7 * DAY_MS);
    if (filter.status === 'due_within_1_hour') {
      return {
        renewedBy: { is: null },
        status: 'active',
        dueAt: { gt: now, lte: oneHour }
      };
    }
    if (filter.status === 'due_within_23_hours') {
      return {
        renewedBy: { is: null },
        status: 'active',
        dueAt: { gt: oneHour, lte: twentyThreeHours }
      };
    }
    return {
      renewedBy: { is: null },
      status: 'active',
      dueAt: { gt: twentyThreeHours, lte: sevenDays }
    };
  }

  private buildWarningWhere(now: Date, warningDays: number) {
    return {
      renewedBy: { is: null },
      status: 'active' as const,
      dueAt: { gt: now, lte: new Date(now.getTime() + warningDays * DAY_MS) }
    };
  }

  private buildExpiredWhere(now: Date): Prisma.IdBusinessV2ActivationWhereInput {
    return {
      renewedBy: { is: null },
      OR: [{ status: 'expired' }, { status: 'active', dueAt: { lte: now } }]
    };
  }

  private buildWorkbenchOrderBy(
    field: string,
    direction: 'asc' | 'desc'
  ): Prisma.IdBusinessV2ActivationOrderByWithRelationInput[] {
    const supported: Record<string, Prisma.IdBusinessV2ActivationOrderByWithRelationInput> = {
      customer: { customer: { name: direction } },
      account: { account: { appleIdMasked: direction } },
      currentBalance: { account: { currentBalance: direction } },
      service: { serviceOption: { name: direction } },
      openedAt: { openedAt: direction },
      dueAt: { dueAt: direction }
    };
    return [supported[field] ?? supported.openedAt, { id: 'desc' }];
  }
}

function mapRenewalRecord(row: RenewalPersistenceRow): RenewalRecord {
  const { displaySnapshot: snapshot, ...order } = row.order;
  return {
    ...row,
    order,
    customer: { ...row.customer, name: snapshot?.customerName ?? row.customer.name },
    account: {
      ...row.account,
      appleIdMasked: snapshot?.accountLabel ?? row.account.appleIdMasked,
      countryOption: {
        ...row.account.countryOption,
        name: snapshot?.accountCountryName ?? row.account.countryOption.name
      },
      currentBalance: mapAmount4(
        row.account.currentBalance,
        'id_business_v2_accounts.current_balance'
      ),
      balanceCostAmount: mapAmount4(
        row.account.balanceCostAmount,
        'id_business_v2_accounts.balance_cost_amount'
      )
    },
    serviceOption: {
      ...row.serviceOption,
      name: snapshot?.serviceName ?? row.serviceOption.name,
      parent: row.serviceOption.parent
        ? {
            ...row.serviceOption.parent,
            name: snapshot?.serviceCategoryName ?? row.serviceOption.parent.name
          }
        : null
    }
  };
}

function mapRenewalWarningSummaryRow<
  TRow extends {
    order: {
      displaySnapshot: {
        customerName: string;
        serviceName: string;
        accountLabel: string | null;
      } | null;
    };
    customer: { id: string; name: string };
    account: { id: string; appleIdEncrypted: string; appleIdMasked: string };
    serviceOption: { id: string; name: string };
  }
>(row: TRow) {
  const summary = { ...row };
  delete (summary as Partial<TRow>).order;
  const snapshot = row.order.displaySnapshot;
  return {
    ...summary,
    customer: { ...row.customer, name: snapshot?.customerName ?? row.customer.name },
    account: {
      ...row.account,
      appleIdMasked: snapshot?.accountLabel ?? row.account.appleIdMasked
    },
    serviceOption: {
      ...row.serviceOption,
      name: snapshot?.serviceName ?? row.serviceOption.name
    }
  };
}

function mapManualRenewalReplay(row: ManualRenewalReplayPersistenceRow): ManualRenewalReplayOrder {
  return {
    ...row,
    receivedAmount: mapAmount4(row.receivedAmount, 'id_business_v2_orders.received_amount'),
    balanceAmount: mapAmount4(row.balanceAmount, 'id_business_v2_orders.balance_amount'),
    balanceCostAmount: mapAmount4(
      row.balanceCostAmount,
      'id_business_v2_orders.balance_cost_amount'
    ),
    profitAmount: mapOptionalAmount4(row.profitAmount, 'id_business_v2_orders.profit_amount'),
    balanceLedger: row.balanceLedger.map(mapManualRenewalLedger)
  };
}

function mapManualRenewalLedger(row: IdBusinessV2BalanceLedger): ManualRenewalLedgerRecord {
  return {
    ...row,
    balanceAmount: mapAmount4(row.balanceAmount, 'id_business_v2_balance_ledgers.balance_amount'),
    costAmount: mapAmount4(row.costAmount, 'id_business_v2_balance_ledgers.cost_amount'),
    balanceBefore: mapAmount4(row.balanceBefore, 'id_business_v2_balance_ledgers.balance_before'),
    balanceAfter: mapAmount4(row.balanceAfter, 'id_business_v2_balance_ledgers.balance_after'),
    costBefore: mapAmount4(row.costBefore, 'id_business_v2_balance_ledgers.cost_before'),
    costAfter: mapAmount4(row.costAfter, 'id_business_v2_balance_ledgers.cost_after'),
    averageCostBefore: mapRate8(
      row.averageCostBefore,
      'id_business_v2_balance_ledgers.average_cost_before'
    ),
    averageCostAfter: mapRate8(
      row.averageCostAfter,
      'id_business_v2_balance_ledgers.average_cost_after'
    )
  };
}
