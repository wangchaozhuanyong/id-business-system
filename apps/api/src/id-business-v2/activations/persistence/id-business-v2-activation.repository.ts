import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { mapAmount4, mapOptionalAmount4 } from '../../runtime/public-api';
import type { ActivationListCriteria, ActivationRecord } from '../activation.types';
import type { IdBusinessV2ActivationDueStatusFilter } from '../id-business-v2-activation-status.service';

const ACTIVATION_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNo: true,
      status: true,
      websiteAccountMasked: true,
      receivedAmount: true,
      profitAmount: true
    }
  },
  customer: { select: { id: true, name: true } },
  account: {
    select: {
      id: true,
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
          AND: [where, { status: 'active', dueAt: { gt: criteria.evaluatedAt } }]
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
    return {
      customerId: criteria.customerId ?? undefined,
      serviceOptionId: criteria.serviceOptionId ?? undefined,
      accountId: criteria.accountId ?? undefined,
      status: criteria.status ?? undefined,
      openedAt: criteria.openedAt,
      dueAt: criteria.dueAt,
      AND: criteria.dueFilter ? [this.mapDueFilter(criteria.dueFilter)] : undefined,
      OR: criteria.keyword
        ? [
            { order: { is: { orderNo: { contains: criteria.keyword, mode: 'insensitive' } } } },
            { customer: { is: { name: { contains: criteria.keyword, mode: 'insensitive' } } } },
            {
              serviceOption: { is: { name: { contains: criteria.keyword, mode: 'insensitive' } } }
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
            }
          ]
        : undefined
    };
  }

  private mapDueFilter(
    filter: IdBusinessV2ActivationDueStatusFilter
  ): Prisma.IdBusinessV2ActivationWhereInput {
    if (filter.kind === 'stored_status') return { status: filter.status };
    if (filter.kind === 'expired') {
      return {
        OR: [{ status: 'expired' }, { status: 'active', dueAt: { lte: filter.evaluatedAt } }]
      };
    }
    if (filter.kind === 'active') {
      return { status: 'active', OR: [{ dueAt: null }, { dueAt: { gt: filter.after } }] };
    }
    return {
      status: 'active',
      dueAt: { gt: filter.after, lte: filter.atOrBefore }
    };
  }
}

function mapActivationRow(row: ActivationPersistenceRow): ActivationRecord {
  return {
    ...row,
    order: {
      ...row.order,
      receivedAmount: mapAmount4(row.order.receivedAmount, 'id_business_v2_orders.received_amount'),
      profitAmount: mapOptionalAmount4(
        row.order.profitAmount,
        'id_business_v2_orders.profit_amount'
      )
    }
  };
}
