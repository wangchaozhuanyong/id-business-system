import { Injectable } from '@nestjs/common';
import type { IdBusinessV2ActivationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { mapAmount4, mapOptionalAmount4 } from '../../runtime/public-api';
import type { ActivationListCriteria, ActivationRecord } from '../activation.types';
import {
  buildIdBusinessV2EffectiveActivationWhere,
  ID_BUSINESS_V2_ACTIVE_BALANCE_RETURN_SELECT
} from './id-business-v2-effective-activation.query';
import type { IdBusinessV2ActivationDueStatusFilter } from '../id-business-v2-activation-status.service';

const ACTIVATION_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNo: true,
      status: true,
      websiteAccountMasked: true,
      websiteAccountEncrypted: true,
      receivedAmount: true,
      profitAmount: true,
      displaySnapshot: true,
      balanceReturns: ID_BUSINESS_V2_ACTIVE_BALANCE_RETURN_SELECT
    }
  },
  customer: { select: { id: true, name: true } },
  account: {
    select: {
      id: true,
      appleIdEncrypted: true,
      appleIdMasked: true,
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
  },
  renewedBy: {
    select: {
      id: true,
      serviceOptionId: true
    }
  },
  createdBy: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  }
} satisfies Prisma.IdBusinessV2ActivationInclude;

type ActivationPersistenceRow = Prisma.IdBusinessV2ActivationGetPayload<{
  include: typeof ACTIVATION_INCLUDE;
}>;

@Injectable()
export class IdBusinessV2ActivationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(criteria: ActivationListCriteria) {
    const where = this.buildWhere(criteria);
    const [rows, total, nextTimedActivation] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Activation.findMany({
        where,
        include: ACTIVATION_INCLUDE,
        skip: criteria.skip,
        take: criteria.take,
        orderBy: [{ [criteria.sortField]: criteria.sortDirection }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2Activation.count({ where }),
      this.prisma.idBusinessV2Activation.findFirst({
        where: {
          AND: [
            where,
            buildIdBusinessV2EffectiveActivationWhere(),
            {
              renewedBy: { is: null },
              status: 'active',
              dueAt: { gt: criteria.evaluatedAt }
            }
          ]
        },
        select: { dueAt: true },
        orderBy: { dueAt: 'asc' }
      })
    ]);
    return {
      items: rows.map(mapActivationRow),
      total,
      nextTimedDueAt: nextTimedActivation?.dueAt ?? null
    };
  }

  async findById(id: string) {
    const row = await this.prisma.idBusinessV2Activation.findUnique({
      where: { id },
      include: ACTIVATION_INCLUDE
    });
    return row ? mapActivationRow(row) : null;
  }

  private buildWhere(criteria: ActivationListCriteria): Prisma.IdBusinessV2ActivationWhereInput {
    const keywordWhere: Prisma.IdBusinessV2ActivationWhereInput | null = criteria.keyword
      ? {
          OR: [
            { order: { is: { orderNo: { contains: criteria.keyword } } } },
            { customer: { is: { name: { contains: criteria.keyword } } } },
            { serviceOption: { is: { name: { contains: criteria.keyword } } } },
            { account: { is: { appleIdMasked: { contains: criteria.keyword } } } },
            { order: { is: { websiteAccountMasked: { contains: criteria.keyword } } } },
            {
              order: {
                is: {
                  displaySnapshot: {
                    is: {
                      OR: [
                        { customerName: { contains: criteria.keyword } },
                        { serviceName: { contains: criteria.keyword } },
                        { accountLabel: { contains: criteria.keyword } }
                      ]
                    }
                  }
                }
              }
            }
          ]
        }
      : null;
    const filters = [
      criteria.status ? this.mapStoredStatus(criteria.status) : null,
      criteria.dueFilter ? this.mapDueFilter(criteria.dueFilter) : null,
      keywordWhere
    ].filter((item): item is Prisma.IdBusinessV2ActivationWhereInput => item !== null);
    return {
      customerId: criteria.customerId ?? undefined,
      serviceOptionId: criteria.serviceOptionId ?? undefined,
      accountId: criteria.accountId ?? undefined,
      openedAt: criteria.openedAt,
      dueAt: criteria.dueAt,
      AND: filters.length ? filters : undefined
    };
  }

  private mapDueFilter(
    filter: IdBusinessV2ActivationDueStatusFilter
  ): Prisma.IdBusinessV2ActivationWhereInput {
    if (filter.kind === 'stored_status') return this.mapStoredStatus(filter.status);
    if (filter.kind === 'expired') {
      return {
        AND: [buildIdBusinessV2EffectiveActivationWhere()],
        renewedBy: { is: null },
        OR: [{ status: 'expired' }, { status: 'active', dueAt: { lte: filter.evaluatedAt } }]
      };
    }
    if (filter.kind === 'active') {
      return {
        AND: [buildIdBusinessV2EffectiveActivationWhere()],
        renewedBy: { is: null },
        status: 'active',
        OR: [{ dueAt: null }, { dueAt: { gt: filter.after } }]
      };
    }
    return {
      AND: [buildIdBusinessV2EffectiveActivationWhere()],
      renewedBy: { is: null },
      status: 'active',
      dueAt: { gt: filter.after, lte: filter.atOrBefore }
    };
  }

  private mapStoredStatus(
    status: IdBusinessV2ActivationStatus | null
  ): Prisma.IdBusinessV2ActivationWhereInput {
    if (!status) return {};
    if (status === 'cancelled') {
      return {
        OR: [
          { status: 'cancelled' },
          { order: { is: { balanceReturns: { some: { status: 'active' } } } } }
        ]
      };
    }
    return {
      status,
      AND: [buildIdBusinessV2EffectiveActivationWhere()]
    };
  }
}

function mapActivationRow(row: ActivationPersistenceRow): ActivationRecord {
  const { displaySnapshot: snapshot, balanceReturns, ...order } = row.order;
  return {
    ...row,
    hasActiveUpgradeBalanceReturn: (balanceReturns?.length ?? 0) > 0,
    order: {
      ...order,
      receivedAmount: mapAmount4(order.receivedAmount, 'id_business_v2_orders.received_amount'),
      profitAmount: mapOptionalAmount4(order.profitAmount, 'id_business_v2_orders.profit_amount')
    },
    customer: { ...row.customer, name: snapshot?.customerName ?? row.customer.name },
    account: {
      ...row.account,
      appleIdMasked: snapshot?.accountLabel ?? row.account.appleIdMasked,
      countryOption: {
        ...row.account.countryOption,
        name: snapshot?.accountCountryName ?? row.account.countryOption.name
      }
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
