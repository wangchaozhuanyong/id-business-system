import { BadRequestException, Injectable } from '@nestjs/common';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { Amount4, V2_DECIMAL_PATTERN, V2_DECIMAL_PLACES } from '../runtime/public-api';
import type { SearchIdBusinessV2OrderCandidatesDto } from './dto/search-id-business-v2-order-candidates.dto';
import type { IdBusinessV2MatchingAccount } from './id-business-v2-order.types';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

export interface FindIdBusinessV2OrderCandidatesQuery {
  serviceOptionId?: string;
  accountSource?: string;
  customerId?: string;
  balanceAmount?: string;
  orderId?: string;
  limit?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BALANCE = Amount4.from('99999999999999.9999');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
@Injectable()
export class IdBusinessV2OrderMatchingService {
  constructor(
    private readonly repository: IdBusinessV2OrdersRepository,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly fieldEncryptionService: FieldEncryptionService
  ) {}

  async findCandidates(query: FindIdBusinessV2OrderCandidatesQuery) {
    if (query.accountSource === 'customer_owned') {
      throw new BadRequestException('客户已购 ID 必须手动搜索选择');
    }
    return this.findEligibleCandidates(query, null, true);
  }

  async searchManualCandidates(dto: SearchIdBusinessV2OrderCandidatesDto) {
    const keyword = this.normalizeSearchKeyword(dto.keyword);
    return this.findEligibleCandidates(
      {
        serviceOptionId: dto.serviceOptionId,
        accountSource: dto.accountSource,
        customerId: dto.customerId,
        balanceAmount:
          dto.balanceAmount === undefined || dto.balanceAmount === null
            ? undefined
            : String(dto.balanceAmount),
        limit: dto.limit === undefined || dto.limit === null ? undefined : String(dto.limit)
      },
      keyword,
      false
    );
  }

  private async findEligibleCandidates(
    query: FindIdBusinessV2OrderCandidatesQuery,
    keyword: string | null,
    autoSelect: boolean
  ) {
    const serviceOptionId = this.normalizeRequiredUuid(query.serviceOptionId, '业务');
    const requiredBalance = this.normalizeRequiredBalance(query.balanceAmount);
    const limit = this.normalizeLimit(query.limit);
    const editingOrderId = query.orderId ? this.normalizeRequiredUuid(query.orderId, '订单') : null;
    const accountSource = this.normalizeAccountSource(query.accountSource);
    const customerId =
      accountSource === 'customer_owned'
        ? this.normalizeRequiredUuid(query.customerId, '客户')
        : null;
    const context = await this.resolveMatchingContext(serviceOptionId);
    const evaluatedAt = new Date();

    const result = await this.repository.findMatchingCandidates({
      countryOptionId: context.country.id,
      categoryOptionId: context.category.id,
      serviceOptionId,
      editingOrderId,
      accountSource,
      customerId,
      requiredBalance: requiredBalance.toString(),
      evaluatedAt,
      keyword,
      keywordHash: keyword
        ? this.fieldEncryptionService.hash(keyword.toLocaleLowerCase('en-US'))
        : null,
      limit
    });

    return {
      criteria: {
        service: context.service,
        category: context.category,
        country: context.country,
        requiredBalance: requiredBalance.toString(),
        requiredStatusCode: 'normal',
        accountSource,
        customerId,
        evaluatedAt
      },
      counts: {
        ...result.counts
      },
      revalidateAt: result.nextAvailabilityChangesAt,
      selectedCandidateId: autoSelect ? (result.accounts[0]?.id ?? null) : null,
      items: result.accounts.map((account) => this.toCandidateResponse(account, requiredBalance))
    };
  }

  private async resolveMatchingContext(serviceOptionId: string) {
    const context = await this.repository.findMatchingContext(serviceOptionId);
    if (!context) {
      throw new BadRequestException('业务不存在、已停用或没有完整的国家和分类');
    }
    return context;
  }

  private normalizeRequiredBalance(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized || !V2_DECIMAL_PATTERN.test(normalized)) {
      throw new BadRequestException(`消耗余额必须是最多 ${V2_DECIMAL_PLACES} 位小数的正数`);
    }
    const balance = Amount4.from(normalized);
    if (balance.lte(0)) {
      throw new BadRequestException('消耗余额必须大于 0');
    }
    if (balance.gt(MAX_BALANCE)) {
      throw new BadRequestException('消耗余额数值过大');
    }
    return balance;
  }

  private normalizeLimit(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return DEFAULT_LIMIT;
    const limit = Number(normalized);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`候选数量必须是 1 到 ${MAX_LIMIT} 的整数`);
    }
    return limit;
  }

  private normalizeRequiredUuid(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized || !UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  private normalizeSearchKeyword(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (normalized && normalized.length > 255) {
      throw new BadRequestException('ID 搜索词过长');
    }
    return normalized;
  }

  private normalizeAccountSource(value: unknown) {
    const normalized = this.normalizeNullableString(value) ?? 'inventory';
    if (normalized === 'inventory' || normalized === 'customer_owned') return normalized;
    throw new BadRequestException('ID 来源无效');
  }

  private normalizeNullableString(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException('参数格式无效');
    }
    return String(value).trim() || null;
  }

  private toCandidateResponse(account: IdBusinessV2MatchingAccount, requiredBalance: Amount4) {
    const { currentBalance, balanceCostAmount, purchaseCost } = account;
    const consumption = this.balanceCalculator.calculateConsumption(
      {
        currentBalance,
        balanceCostAmount
      },
      requiredBalance
    );
    return {
      id: account.id,
      appleIdMasked: account.appleIdMasked,
      country: account.countryOption,
      status: account.statusOption,
      currentBalance: currentBalance.toString(),
      balanceCostAmount: balanceCostAmount.toString(),
      estimatedBalanceCostAmount: consumption.costAmount.toString(),
      averageCost: this.balanceCalculator
        .calculateAverageCost(currentBalance, balanceCostAmount)
        .toString(),
      purchaseCost: purchaseCost.toString(),
      saleState: account.soldByOrder ? 'sold' : 'unsold',
      sourceSoldOrder: account.soldByOrder,
      balanceAfterMatch: currentBalance.sub(requiredBalance).toString(),
      updatedAt: account.updatedAt
    };
  }
}
