import { Injectable } from '@nestjs/common';
import type { IdBusinessV2ActivationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  buildV2StringArrayContainsFilter,
  mapAmount4,
  type Amount4
} from '../../runtime/public-api';

export interface TopupWorkbenchBalanceRange {
  equals?: string;
  gt?: string;
  gte?: string;
  lt?: string;
  lte?: string;
}

export type TopupWorkbenchSortField =
  | 'appleIdMasked'
  | 'currentBalance'
  | 'balanceCostAmount'
  | 'updatedAt';

export interface TopupWorkbenchCriteria {
  keyword: string | null;
  appleIdSearchTokens: string[];
  accountSource: 'inventory' | 'customer_owned' | null;
  countryOptionId: string | null;
  balanceRange?: TopupWorkbenchBalanceRange;
  onlyNormal: boolean;
  sortField: TopupWorkbenchSortField | null;
  sortDirection: 'asc' | 'desc';
  skip: number;
  take: number;
}

const WORKBENCH_ACCOUNT_INCLUDE = {
  countryOption: { select: { id: true, code: true, name: true } },
  statusOption: { select: { id: true, code: true, name: true, isSystem: true } },
  soldByOrder: {
    select: {
      id: true,
      orderNo: true,
      customer: { select: { id: true, name: true } }
    }
  },
  giftCards: {
    select: { createdAt: true },
    orderBy: { createdAt: 'desc' as const },
    take: 1
  },
  activations: {
    select: {
      id: true,
      status: true,
      openedAt: true,
      dueAt: true,
      serviceOption: {
        select: {
          id: true,
          code: true,
          name: true,
          parent: { select: { id: true, name: true } }
        }
      }
    },
    orderBy: [{ openedAt: 'desc' as const }, { id: 'asc' as const }]
  },
  _count: { select: { giftCards: true, balanceLedger: true } }
} satisfies Prisma.IdBusinessV2AccountInclude;

type WorkbenchPersistenceRow = Prisma.IdBusinessV2AccountGetPayload<{
  include: typeof WORKBENCH_ACCOUNT_INCLUDE;
}>;

export interface WorkbenchAccountRow {
  id: string;
  appleIdEncrypted: string;
  appleIdMasked: string;
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  updatedAt: Date;
  countryOption: { id: string; code: string; name: string };
  statusOption: { id: string; code: string; name: string; isSystem: boolean };
  soldByOrder: {
    id: string;
    orderNo: string;
    customer: { id: string; name: string };
  } | null;
  giftCards: Array<{ createdAt: Date }>;
  activations: Array<{
    id: string;
    status: IdBusinessV2ActivationStatus;
    openedAt: Date;
    dueAt: Date | null;
    serviceOption: {
      id: string;
      code: string;
      name: string;
      parent: { id: string; name: string } | null;
    };
  }>;
  counts: { giftCards: number; balanceLedger: number };
}

@Injectable()
export class IdBusinessV2BalanceQueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listTopupWorkbench(criteria: TopupWorkbenchCriteria) {
    const where: Prisma.IdBusinessV2AccountWhereInput = {
      deletedAt: null,
      recordStatus: 'active',
      lossReportedAt: null,
      soldByOrderId:
        criteria.accountSource === 'inventory'
          ? null
          : criteria.accountSource === 'customer_owned'
            ? { not: null }
            : undefined,
      countryOptionId: criteria.countryOptionId ?? undefined,
      OR: criteria.keyword
        ? [
            { appleIdMasked: { contains: criteria.keyword } },
            {
              appleIdSearchTokens: buildV2StringArrayContainsFilter(criteria.appleIdSearchTokens)
            },
            {
              soldByOrder: {
                is: { orderNo: { contains: criteria.keyword } }
              }
            }
          ]
        : undefined,
      currentBalance: criteria.balanceRange,
      statusOption: criteria.onlyNormal
        ? {
            is: {
              type: 'id_status',
              code: 'normal',
              status: 'active',
              deletedAt: null
            }
          }
        : undefined
    };
    const orderBy: Prisma.IdBusinessV2AccountOrderByWithRelationInput[] = criteria.sortField
      ? [{ [criteria.sortField]: criteria.sortDirection }, { updatedAt: 'desc' }, { id: 'desc' }]
      : [{ updatedAt: 'desc' }, { id: 'desc' }];
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Account.findMany({
        where,
        include: WORKBENCH_ACCOUNT_INCLUDE,
        skip: criteria.skip,
        take: criteria.take,
        orderBy
      }),
      this.prisma.idBusinessV2Account.count({ where })
    ]);
    return { items: rows.map(mapWorkbenchAccount), total };
  }
}

function mapWorkbenchAccount(row: WorkbenchPersistenceRow): WorkbenchAccountRow {
  const { _count, ...account } = row;
  return {
    ...account,
    currentBalance: mapAmount4(row.currentBalance, 'id_business_v2_accounts.current_balance'),
    balanceCostAmount: mapAmount4(
      row.balanceCostAmount,
      'id_business_v2_accounts.balance_cost_amount'
    ),
    counts: _count
  };
}
