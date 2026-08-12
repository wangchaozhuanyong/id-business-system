import { BadRequestException, Injectable } from '@nestjs/common';
import { V2_DECIMAL_PLACES, v2UnsignedDecimalPattern } from '@apple-business/shared';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { Amount4 } from '../runtime/public-api';
import { IdBusinessV2BalanceCalculatorService } from './id-business-v2-balance-calculator.service';
import {
  IdBusinessV2BalanceQueryRepository,
  type TopupWorkbenchBalanceRange,
  type TopupWorkbenchSortField,
  type WorkbenchAccountRow
} from './persistence/id-business-v2-balance-query.repository';

type TopupWorkbenchBalancePreset = 'zero' | 'positive_under_20' | 'custom';

export interface ListIdBusinessV2TopupWorkbenchQuery extends PaginationQuery {
  keyword?: string;
  accountSource?: string;
  countryOptionId?: string;
  balancePreset?: string;
  balanceMin?: string;
  balanceMax?: string;
  onlyNormal?: string;
  sortBy?: string;
  sortOrder?: string;
}

const WORKBENCH_SORT_FIELDS: Record<string, TopupWorkbenchSortField> = {
  appleId: 'appleIdMasked',
  currentBalance: 'currentBalance',
  balanceCostAmount: 'balanceCostAmount',
  updatedAt: 'updatedAt'
};

const MAX_BALANCE = Amount4.from('99999999999999.9999');
const BALANCE_PATTERN = v2UnsignedDecimalPattern(V2_DECIMAL_PLACES);

@Injectable()
export class IdBusinessV2TopupWorkbenchService {
  constructor(
    private readonly queryRepository: IdBusinessV2BalanceQueryRepository,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService
  ) {}

  async list(query: ListIdBusinessV2TopupWorkbenchQuery) {
    const evaluatedAt = new Date();
    const pagination = getPagination(query);
    const balancePreset = this.parseBalancePreset(query.balancePreset);
    const balanceRange = this.buildBalanceRange(balancePreset, query.balanceMin, query.balanceMax);
    const onlyNormal = this.parseBoolean(query.onlyNormal, '只显示正常 ID');
    const keyword = this.normalizeNullableString(query.keyword);
    if (keyword && keyword.length > 255)
      throw new BadRequestException('搜索关键词不能超过 255 个字符');
    const countryOptionId = this.normalizeNullableString(query.countryOptionId);
    const accountSource = this.parseAccountSource(query.accountSource);
    const result = await this.queryRepository.listTopupWorkbench({
      countryOptionId,
      keyword,
      accountSource,
      balanceRange,
      onlyNormal,
      sortField: query.sortBy ? (WORKBENCH_SORT_FIELDS[query.sortBy] ?? null) : null,
      sortDirection: query.sortOrder === 'desc' ? 'desc' : 'asc',
      skip: pagination.skip,
      take: pagination.take
    });

    return {
      items: result.items.map((account) => this.toResponse(account, evaluatedAt)),
      total: result.total,
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

  private parseAccountSource(value: unknown): 'inventory' | 'customer_owned' | null {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (normalized === 'inventory' || normalized === 'customer_owned') return normalized;
    throw new BadRequestException('ID 来源无效');
  }

  private buildBalanceRange(
    preset: TopupWorkbenchBalancePreset | null,
    minimumValue: unknown,
    maximumValue: unknown
  ): TopupWorkbenchBalanceRange | undefined {
    if (preset === 'zero') {
      this.assertNoCustomRange(minimumValue, maximumValue);
      return { equals: '0' };
    }
    if (preset === 'positive_under_20') {
      this.assertNoCustomRange(minimumValue, maximumValue);
      return {
        gt: '0',
        lt: '20'
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
    if (minimum && maximum && minimum.gt(maximum)) {
      throw new BadRequestException('最低余额不能大于最高余额');
    }

    return {
      gte: minimum?.toString(),
      lte: maximum?.toString()
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
    if (!BALANCE_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数字`);
    }

    const balance = Amount4.from(normalized);
    if (balance.gt(MAX_BALANCE)) {
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

  private toResponse(account: WorkbenchAccountRow, evaluatedAt: Date) {
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
      currentBalance: account.currentBalance.toString(),
      balanceCostAmount: account.balanceCostAmount.toString(),
      averageCost: this.balanceCalculator
        .calculateAverageCost(account.currentBalance, account.balanceCostAmount)
        .toString(),
      topupRecordCount: account.counts.giftCards,
      balanceChangeCount: account.counts.balanceLedger,
      lastTopupAt: account.giftCards[0]?.createdAt ?? null,
      updatedAt: account.updatedAt,
      status: account.statusOption,
      saleState: account.soldByOrder ? 'sold' : 'available',
      soldByOrder: account.soldByOrder,
      historicalServices,
      currentServices,
      serviceDataAvailable: true
    };
  }

  private uniqueServices(
    activations: Array<Pick<WorkbenchAccountRow['activations'][number], 'serviceOption'>>
  ) {
    const services = new Map<string, WorkbenchAccountRow['activations'][number]['serviceOption']>();
    for (const activation of activations) {
      if (!services.has(activation.serviceOption.id)) {
        services.set(activation.serviceOption.id, activation.serviceOption);
      }
    }
    return [...services.values()];
  }
}
