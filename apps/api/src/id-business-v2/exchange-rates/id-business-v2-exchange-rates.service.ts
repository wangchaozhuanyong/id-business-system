import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CreateIdBusinessV2ExchangeRateEntryDto } from './dto/create-id-business-v2-exchange-rate-entry.dto';

export interface ListIdBusinessV2ExchangeRatesQuery extends PaginationQuery {
  keyword?: string;
  recordedFrom?: string;
  recordedTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RATE = new Prisma.Decimal('9999999999.99999999');
const TWO = new Prisma.Decimal(2);
const DECIMAL_PLACES = 8;
const ROUNDING_MODE = Prisma.Decimal.ROUND_HALF_UP;

const ENTRY_INCLUDE = {
  createdBy: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  }
} satisfies Prisma.IdBusinessV2ExchangeRateEntryInclude;

type ExchangeRateEntryRecord = Prisma.IdBusinessV2ExchangeRateEntryGetPayload<{
  include: typeof ENTRY_INCLUDE;
}>;

const SORT_FIELDS: Record<
  string,
  keyof Prisma.IdBusinessV2ExchangeRateEntryOrderByWithRelationInput
> = {
  recordedAt: 'recordedAt',
  createdAt: 'createdAt'
};

@Injectable()
export class IdBusinessV2ExchangeRatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListIdBusinessV2ExchangeRatesQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const recordedAt = this.parseDateRange(query.recordedFrom, query.recordedTo);
    const where: Prisma.IdBusinessV2ExchangeRateEntryWhereInput = {
      recordedAt,
      OR: keyword
        ? [
            ...(UUID_PATTERN.test(keyword) ? [{ id: keyword }] : []),
            { remark: { contains: keyword, mode: 'insensitive' } },
            {
              createdBy: {
                is: {
                  username: { contains: keyword, mode: 'insensitive' }
                }
              }
            },
            {
              createdBy: {
                is: {
                  displayName: { contains: keyword, mode: 'insensitive' }
                }
              }
            }
          ]
        : undefined
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2ExchangeRateEntry.findMany({
        where,
        include: ENTRY_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.idBusinessV2ExchangeRateEntry.count({ where })
    ]);

    return {
      items: items.map((entry) => this.toResponse(entry)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async getOverview() {
    const [latestEntry, total] = await Promise.all([
      this.prisma.idBusinessV2ExchangeRateEntry.findFirst({
        include: ENTRY_INCLUDE,
        orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2ExchangeRateEntry.count()
    ]);

    return {
      latestEntry: latestEntry ? this.toResponse(latestEntry) : null,
      total,
      calculationRule: '综合买入和综合卖出分别取 Binance 与 OKX 的算术平均值，中间价再取二者平均值'
    };
  }

  async get(idValue: string) {
    const id = this.normalizeUuid(idValue);
    const entry = await this.prisma.idBusinessV2ExchangeRateEntry.findUnique({
      where: { id },
      include: ENTRY_INCLUDE
    });

    if (!entry) {
      throw new NotFoundException('手工汇率记录不存在');
    }

    return this.toResponse(entry);
  }

  async create(dto: CreateIdBusinessV2ExchangeRateEntryDto, operator?: AuthenticatedUser) {
    if (!operator?.id) {
      throw new BadRequestException('无法识别当前操作人');
    }

    const binanceMerchantBuyRateToRmb = this.parseRate(
      dto.binanceMerchantBuyRateToRmb,
      'Binance 商家买入价'
    );
    const binanceMerchantSellRateToRmb = this.parseRate(
      dto.binanceMerchantSellRateToRmb,
      'Binance 商家卖出价'
    );
    const okxMerchantBuyRateToRmb = this.parseRate(dto.okxMerchantBuyRateToRmb, 'OKX 商家买入价');
    const okxMerchantSellRateToRmb = this.parseRate(dto.okxMerchantSellRateToRmb, 'OKX 商家卖出价');
    const combinedMerchantBuyAverageRateToRmb = this.average(
      binanceMerchantBuyRateToRmb,
      okxMerchantBuyRateToRmb
    );
    const combinedMerchantSellAverageRateToRmb = this.average(
      binanceMerchantSellRateToRmb,
      okxMerchantSellRateToRmb
    );
    const midRateToRmb = this.average(
      combinedMerchantBuyAverageRateToRmb,
      combinedMerchantSellAverageRateToRmb
    );
    const recordedAt = this.parseRecordedAt(dto.recordedAt);
    const remark = this.normalizeRemark(dto.remark);

    const entry = await this.prisma.$transaction(async (tx) => {
      const created = await tx.idBusinessV2ExchangeRateEntry.create({
        data: {
          binanceMerchantBuyRateToRmb,
          binanceMerchantSellRateToRmb,
          okxMerchantBuyRateToRmb,
          okxMerchantSellRateToRmb,
          combinedMerchantBuyAverageRateToRmb,
          combinedMerchantSellAverageRateToRmb,
          midRateToRmb,
          recordedAt,
          remark,
          createdByUserId: operator.id
        },
        include: ENTRY_INCLUDE
      });

      await tx.auditLog.create({
        data: {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.manual.create',
          objectType: 'id_business_v2_exchange_rate_entry',
          objectId: created.id,
          afterData: {
            binanceMerchantBuyRateToRmb: binanceMerchantBuyRateToRmb.toString(),
            binanceMerchantSellRateToRmb: binanceMerchantSellRateToRmb.toString(),
            okxMerchantBuyRateToRmb: okxMerchantBuyRateToRmb.toString(),
            okxMerchantSellRateToRmb: okxMerchantSellRateToRmb.toString(),
            combinedMerchantBuyAverageRateToRmb: combinedMerchantBuyAverageRateToRmb.toString(),
            combinedMerchantSellAverageRateToRmb: combinedMerchantSellAverageRateToRmb.toString(),
            midRateToRmb: midRateToRmb.toString(),
            recordedAt: recordedAt.toISOString(),
            remark
          },
          remark: 'V2 手工汇率录入'
        }
      });

      return created;
    });

    return this.toResponse(entry);
  }

  private average(left: Prisma.Decimal, right: Prisma.Decimal) {
    return left.plus(right).dividedBy(TWO).toDecimalPlaces(DECIMAL_PLACES, ROUNDING_MODE);
  }

  private parseRate(value: unknown, label: string) {
    const normalized =
      typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';

    if (!normalized) {
      throw new BadRequestException(`${label}不能为空`);
    }

    let rate: Prisma.Decimal;
    try {
      rate = new Prisma.Decimal(normalized);
    } catch {
      throw new BadRequestException(`${label}格式无效`);
    }

    if (!rate.isFinite() || rate.lte(0)) {
      throw new BadRequestException(`${label}必须大于 0`);
    }

    const rounded = rate.toDecimalPlaces(DECIMAL_PLACES, ROUNDING_MODE);
    if (rounded.gt(MAX_RATE)) {
      throw new BadRequestException(`${label}超出允许范围`);
    }

    return rounded;
  }

  private parseRecordedAt(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      throw new BadRequestException('记录时间不能为空');
    }

    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('记录时间格式无效');
    }

    return date;
  }

  private parseDateRange(fromValue?: string, toValue?: string) {
    const from = this.parseDateBoundary(fromValue, false);
    const to = this.parseDateBoundary(toValue, true);
    if (from && to && from > to) {
      throw new BadRequestException('记录开始日期不能晚于结束日期');
    }
    if (!from && !to) return undefined;
    return {
      gte: from,
      lte: to
    };
  }

  private parseDateBoundary(value: string | undefined, endOfDay: boolean) {
    const normalized = value?.trim();
    if (!normalized) return undefined;
    if (!DATE_PATTERN.test(normalized)) {
      throw new BadRequestException('记录日期格式必须为 YYYY-MM-DD');
    }
    const date = new Date(`${normalized}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('记录日期无效');
    }
    return date;
  }

  private buildOrderBy(query: ListIdBusinessV2ExchangeRatesQuery) {
    const field = SORT_FIELDS[query.sortBy ?? 'recordedAt'] ?? 'recordedAt';
    const direction = query.sortOrder === 'asc' ? 'asc' : 'desc';
    return [
      { [field]: direction },
      { createdAt: 'desc' },
      { id: 'desc' }
    ] as Prisma.IdBusinessV2ExchangeRateEntryOrderByWithRelationInput[];
  }

  private normalizeKeyword(value?: string) {
    const normalized = value?.trim();
    if (!normalized) return undefined;
    if (normalized.length > 100) {
      throw new BadRequestException('搜索内容不能超过 100 个字符');
    }
    return normalized;
  }

  private normalizeRemark(value: unknown) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
      throw new BadRequestException('备注格式无效');
    }
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > 2000) {
      throw new BadRequestException('备注不能超过 2000 个字符');
    }
    return normalized;
  }

  private normalizeUuid(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!UUID_PATTERN.test(normalized)) {
      throw new BadRequestException('汇率记录编号格式无效');
    }
    return normalized;
  }

  private toResponse(entry: ExchangeRateEntryRecord) {
    return {
      id: entry.id,
      binanceMerchantBuyRateToRmb: entry.binanceMerchantBuyRateToRmb.toString(),
      binanceMerchantSellRateToRmb: entry.binanceMerchantSellRateToRmb.toString(),
      okxMerchantBuyRateToRmb: entry.okxMerchantBuyRateToRmb.toString(),
      okxMerchantSellRateToRmb: entry.okxMerchantSellRateToRmb.toString(),
      combinedMerchantBuyAverageRateToRmb: entry.combinedMerchantBuyAverageRateToRmb.toString(),
      combinedMerchantSellAverageRateToRmb: entry.combinedMerchantSellAverageRateToRmb.toString(),
      midRateToRmb: entry.midRateToRmb.toString(),
      recordedAt: entry.recordedAt,
      remark: entry.remark,
      createdBy: entry.createdBy,
      createdAt: entry.createdAt
    };
  }
}
