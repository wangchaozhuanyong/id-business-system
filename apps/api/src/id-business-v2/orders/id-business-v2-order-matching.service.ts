import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { V2_DECIMAL_PATTERN, V2_DECIMAL_PLACES, toV2DecimalString } from '../decimal-policy';
import type { SearchIdBusinessV2OrderCandidatesDto } from './dto/search-id-business-v2-order-candidates.dto';

export interface FindIdBusinessV2OrderCandidatesQuery {
  serviceOptionId?: string;
  balanceAmount?: string;
  orderId?: string;
  limit?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BALANCE = new PrismaNamespace.Decimal('99999999999999.9999');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MATCHING_ACCOUNT_SELECT = {
  id: true,
  appleIdMasked: true,
  currentBalance: true,
  balanceCostAmount: true,
  purchaseCost: true,
  updatedAt: true,
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
      name: true
    }
  }
} satisfies Prisma.IdBusinessV2AccountSelect;

type MatchingAccount = Prisma.IdBusinessV2AccountGetPayload<{
  select: typeof MATCHING_ACCOUNT_SELECT;
}>;

@Injectable()
export class IdBusinessV2OrderMatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly fieldEncryptionService: FieldEncryptionService
  ) {}

  async findCandidates(query: FindIdBusinessV2OrderCandidatesQuery) {
    return this.findEligibleCandidates(query, null, true);
  }

  async searchManualCandidates(dto: SearchIdBusinessV2OrderCandidatesDto) {
    const keyword = this.normalizeSearchKeyword(dto.keyword);
    return this.findEligibleCandidates(
      {
        serviceOptionId: dto.serviceOptionId,
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
    const context = await this.resolveMatchingContext(serviceOptionId);
    const evaluatedAt = new Date();

    const activeInCountryWhere: Prisma.IdBusinessV2AccountWhereInput = {
      deletedAt: null,
      recordStatus: 'active',
      lossReportedAt: null,
      countryOptionId: context.country.id,
      soldByOrderId: editingOrderId ? undefined : null,
      AND: editingOrderId
        ? [{ OR: [{ soldByOrderId: null }, { soldByOrderId: editingOrderId }] }]
        : undefined
    };
    const normalStatusWhere: Prisma.IdBusinessV2AccountWhereInput = {
      ...activeInCountryWhere,
      statusOption: {
        is: {
          type: 'id_status',
          code: 'normal',
          status: 'active',
          deletedAt: null
        }
      }
    };
    const sufficientBalanceWhere: Prisma.IdBusinessV2AccountWhereInput = {
      ...normalStatusWhere,
      currentBalance: {
        gte: requiredBalance
      }
    };
    const availableWhere: Prisma.IdBusinessV2AccountWhereInput = {
      ...sufficientBalanceWhere,
      locks: {
        none: {
          status: 'active',
          expiresAt: {
            gt: evaluatedAt
          },
          OR: [
            {
              lockScope: 'global'
            },
            {
              lockScope: 'by_service',
              serviceOptionId
            }
          ],
          orderId: editingOrderId ? { not: editingOrderId } : undefined
        }
      }
    };
    const candidateWhere: Prisma.IdBusinessV2AccountWhereInput = keyword
      ? {
          ...availableWhere,
          OR: [
            {
              appleIdMasked: {
                contains: keyword,
                mode: 'insensitive'
              }
            },
            {
              appleIdHash: this.fieldEncryptionService.hash(keyword.toLocaleLowerCase('en-US'))!
            }
          ]
        }
      : availableWhere;

    const [activeInCountry, normalStatus, sufficientBalance, available, accounts, nextLock] =
      await this.prisma.$transaction([
        this.prisma.idBusinessV2Account.count({
          where: activeInCountryWhere
        }),
        this.prisma.idBusinessV2Account.count({
          where: normalStatusWhere
        }),
        this.prisma.idBusinessV2Account.count({
          where: sufficientBalanceWhere
        }),
        this.prisma.idBusinessV2Account.count({
          where: availableWhere
        }),
        this.prisma.idBusinessV2Account.findMany({
          where: candidateWhere,
          select: MATCHING_ACCOUNT_SELECT,
          take: limit,
          orderBy: [
            {
              currentBalance: 'asc'
            },
            {
              updatedAt: 'asc'
            },
            {
              id: 'asc'
            }
          ]
        }),
        this.prisma.idBusinessV2AccountLock.findFirst({
          where: {
            status: 'active',
            expiresAt: {
              gt: evaluatedAt
            },
            OR: [
              {
                lockScope: 'global'
              },
              {
                lockScope: 'by_service',
                serviceOptionId
              }
            ],
            account: {
              is: sufficientBalanceWhere
            }
          },
          select: {
            expiresAt: true
          },
          orderBy: {
            expiresAt: 'asc'
          }
        })
      ]);

    return {
      criteria: {
        service: context.service,
        category: context.category,
        country: context.country,
        requiredBalance: toV2DecimalString(requiredBalance),
        requiredStatusCode: 'normal',
        evaluatedAt
      },
      counts: {
        activeInCountry,
        normalStatus,
        sufficientBalance,
        available
      },
      revalidateAt: nextLock?.expiresAt ?? null,
      selectedCandidateId: autoSelect ? (accounts[0]?.id ?? null) : null,
      items: accounts.map((account) => this.toCandidateResponse(account, requiredBalance))
    };
  }

  private async resolveMatchingContext(serviceOptionId: string) {
    const service = await this.prisma.idBusinessV2Option.findFirst({
      where: {
        id: serviceOptionId,
        type: 'service',
        status: 'active',
        deletedAt: null,
        businessAmount: {
          gt: 0
        },
        parent: {
          is: {
            type: 'business_category',
            status: 'active',
            deletedAt: null
          }
        },
        countryOption: {
          is: {
            type: 'country',
            status: 'active',
            deletedAt: null
          }
        }
      },
      select: {
        id: true,
        code: true,
        name: true,
        parent: {
          select: {
            id: true,
            code: true,
            name: true
          }
        },
        countryOption: {
          select: {
            id: true,
            code: true,
            name: true
          }
        }
      }
    });
    const category = service?.parent;
    const country = service?.countryOption;
    if (!service || !category || !country) {
      throw new BadRequestException('业务不存在、已停用或没有完整的国家和分类');
    }

    return {
      service: {
        id: service.id,
        code: service.code,
        name: service.name
      },
      category: {
        id: category.id,
        code: category.code,
        name: category.name
      },
      country: {
        id: country.id,
        code: country.code,
        name: country.name
      }
    };
  }

  private normalizeRequiredBalance(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized || !V2_DECIMAL_PATTERN.test(normalized)) {
      throw new BadRequestException(`消耗余额必须是最多 ${V2_DECIMAL_PLACES} 位小数的正数`);
    }
    const balance = new PrismaNamespace.Decimal(normalized);
    if (balance.lessThanOrEqualTo(0)) {
      throw new BadRequestException('消耗余额必须大于 0');
    }
    if (balance.greaterThan(MAX_BALANCE)) {
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

  private normalizeNullableString(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException('参数格式无效');
    }
    return String(value).trim() || null;
  }

  private toCandidateResponse(account: MatchingAccount, requiredBalance: PrismaNamespace.Decimal) {
    const consumption = this.balanceCalculator.calculateConsumption(
      {
        currentBalance: account.currentBalance,
        balanceCostAmount: account.balanceCostAmount
      },
      requiredBalance
    );
    return {
      id: account.id,
      appleIdMasked: account.appleIdMasked,
      country: account.countryOption,
      status: account.statusOption,
      currentBalance: toV2DecimalString(account.currentBalance),
      balanceCostAmount: toV2DecimalString(account.balanceCostAmount),
      estimatedBalanceCostAmount: toV2DecimalString(consumption.costAmount),
      averageCost: toV2DecimalString(
        this.balanceCalculator.calculateAverageCost(
          account.currentBalance,
          account.balanceCostAmount
        )
      ),
      purchaseCost: toV2DecimalString(account.purchaseCost),
      balanceAfterMatch: toV2DecimalString(
        account.currentBalance.minus(requiredBalance.toString())
      ),
      updatedAt: account.updatedAt
    };
  }
}
