import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2_DECIMAL_PATTERN, V2_DECIMAL_PLACES, toV2DecimalString } from '../decimal-policy';
import { IdBusinessV2BalanceCalculatorService } from './id-business-v2-balance-calculator.service';

type TopupWorkbenchBalancePreset = 'zero' | 'positive_under_20' | 'custom';

export interface ListIdBusinessV2TopupWorkbenchQuery extends PaginationQuery {
  countryOptionId?: string;
  balancePreset?: string;
  balanceMin?: string;
  balanceMax?: string;
  onlyNormal?: string;
  sortBy?: string;
  sortOrder?: string;
}

const WORKBENCH_ACCOUNT_INCLUDE = {
  countryOption: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  statusOption: {
    select: {
      id: true,
      code: true,
      name: true,
      isSystem: true
    }
  },
  giftCards: {
    select: {
      createdAt: true
    },
    orderBy: {
      createdAt: 'desc'
    },
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
          parent: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }
    },
    orderBy: [{ openedAt: 'desc' }, { id: 'asc' }]
  },
  _count: {
    select: {
      giftCards: true,
      balanceLedger: true
    }
  }
} satisfies Prisma.IdBusinessV2AccountInclude;

type WorkbenchAccount = Prisma.IdBusinessV2AccountGetPayload<{
  include: typeof WORKBENCH_ACCOUNT_INCLUDE;
}>;

const WORKBENCH_SORT_FIELDS: Record<
  string,
  keyof Prisma.IdBusinessV2AccountOrderByWithRelationInput
> = {
  appleId: 'appleIdMasked',
  currentBalance: 'currentBalance',
  balanceCostAmount: 'balanceCostAmount',
  updatedAt: 'updatedAt'
};

const MAX_BALANCE = new PrismaNamespace.Decimal('99999999999999.9999');

@Injectable()
export class IdBusinessV2TopupWorkbenchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService
  ) {}

  async list(query: ListIdBusinessV2TopupWorkbenchQuery) {
    const evaluatedAt = new Date();
    const pagination = getPagination(query);
    const balancePreset = this.parseBalancePreset(query.balancePreset);
    const balanceRange = this.buildBalanceRange(balancePreset, query.balanceMin, query.balanceMax);
    const onlyNormal = this.parseBoolean(query.onlyNormal, '只显示正常 ID');
    const countryOptionId = this.normalizeNullableString(query.countryOptionId);
    const where: Prisma.IdBusinessV2AccountWhereInput = {
      deletedAt: null,
      recordStatus: 'active',
      lossReportedAt: null,
      soldByOrderId: null,
      countryOptionId: countryOptionId ?? undefined,
      currentBalance: balanceRange,
      statusOption: onlyNormal
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

    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Account.findMany({
        where,
        include: WORKBENCH_ACCOUNT_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.idBusinessV2Account.count({ where })
    ]);

    return {
      items: items.map((account) => this.toResponse(account, evaluatedAt)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      evaluatedAt
    };
  }

  private parseBalancePreset(value: unknown): TopupWorkbenchBalancePreset | null {
    if (value === undefined || value === null || value === '') return null;
    if (value === 'zero' || value === 'positive_under_20' || value === 'custom') {
      return value;
    }
    throw new BadRequestException('余额范围类型无效');
  }

  private buildBalanceRange(
    preset: TopupWorkbenchBalancePreset | null,
    minimumValue: unknown,
    maximumValue: unknown
  ): Prisma.DecimalFilter | undefined {
    if (preset === 'zero') {
      this.assertNoCustomRange(minimumValue, maximumValue);
      return { equals: new PrismaNamespace.Decimal(0) };
    }
    if (preset === 'positive_under_20') {
      this.assertNoCustomRange(minimumValue, maximumValue);
      return {
        gt: new PrismaNamespace.Decimal(0),
        lt: new PrismaNamespace.Decimal(20)
      };
    }

    const minimum = this.parseOptionalBalance(minimumValue, '最低余额');
    const maximum = this.parseOptionalBalance(maximumValue, '最高余额');
    if (preset !== 'custom') {
      if (minimum || maximum) {
        throw new BadRequestException('请先选择自定义余额范围');
      }
      return undefined;
    }
    if (!minimum && !maximum) {
      throw new BadRequestException('自定义余额范围至少填写一项');
    }
    if (minimum && maximum && minimum.greaterThan(maximum)) {
      throw new BadRequestException('最低余额不能大于最高余额');
    }

    return {
      gte: minimum ?? undefined,
      lte: maximum ?? undefined
    };
  }

  private assertNoCustomRange(minimumValue: unknown, maximumValue: unknown) {
    if (this.normalizeNullableString(minimumValue) || this.normalizeNullableString(maximumValue)) {
      throw new BadRequestException('预设余额范围不能同时填写自定义上下限');
    }
  }

  private parseOptionalBalance(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (!V2_DECIMAL_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数字`);
    }

    const balance = new PrismaNamespace.Decimal(normalized);
    if (balance.greaterThan(MAX_BALANCE)) {
      throw new BadRequestException(`${label}数值过大`);
    }
    return balance;
  }

  private parseBoolean(value: unknown, label: string) {
    if (value === undefined || value === null || value === '' || value === 'false') {
      return false;
    }
    if (value === 'true') return true;
    throw new BadRequestException(`${label}参数无效`);
  }

  private normalizeNullableString(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException('筛选参数格式无效');
    }
    return String(value).trim() || null;
  }

  private buildOrderBy(query: ListIdBusinessV2TopupWorkbenchQuery) {
    const field = query.sortBy ? WORKBENCH_SORT_FIELDS[query.sortBy] : undefined;
    if (!field) {
      return [
        { updatedAt: 'desc' },
        { id: 'desc' }
      ] satisfies Prisma.IdBusinessV2AccountOrderByWithRelationInput[];
    }
    const direction = query.sortOrder === 'desc' ? 'desc' : 'asc';
    return [
      { [field]: direction },
      { updatedAt: 'desc' },
      { id: 'desc' }
    ] as Prisma.IdBusinessV2AccountOrderByWithRelationInput[];
  }

  private toResponse(account: WorkbenchAccount, evaluatedAt: Date) {
    const historicalServices = this.uniqueServices(account.activations);
    const currentServices = this.uniqueServices(
      account.activations.filter(
        (activation) =>
          activation.status === 'active' &&
          (activation.dueAt === null || activation.dueAt.getTime() > evaluatedAt.getTime())
      )
    );

    return {
      id: account.id,
      appleIdMasked: account.appleIdMasked,
      country: account.countryOption,
      currentBalance: toV2DecimalString(account.currentBalance),
      balanceCostAmount: toV2DecimalString(account.balanceCostAmount),
      averageCost: toV2DecimalString(
        this.balanceCalculator.calculateAverageCost(
          account.currentBalance,
          account.balanceCostAmount
        )
      ),
      topupRecordCount: account._count.giftCards,
      balanceChangeCount: account._count.balanceLedger,
      lastTopupAt: account.giftCards[0]?.createdAt ?? null,
      updatedAt: account.updatedAt,
      status: account.statusOption,
      historicalServices,
      currentServices,
      serviceDataAvailable: true
    };
  }

  private uniqueServices(
    activations: Array<Pick<WorkbenchAccount['activations'][number], 'serviceOption'>>
  ) {
    const services = new Map<string, WorkbenchAccount['activations'][number]['serviceOption']>();
    for (const activation of activations) {
      if (!services.has(activation.serviceOption.id)) {
        services.set(activation.serviceOption.id, activation.serviceOption);
      }
    }
    return [...services.values()];
  }
}
