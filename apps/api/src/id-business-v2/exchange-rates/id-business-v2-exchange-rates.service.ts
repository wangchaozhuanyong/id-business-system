import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
  v2UnsignedDecimalPattern
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import type { CreateIdBusinessV2ExchangeRateEntryDto } from './dto/create-id-business-v2-exchange-rate-entry.dto';
import type { CreateIdBusinessV2ManualFxRateDto } from './dto/create-id-business-v2-manual-fx-rate.dto';
import {
  Rate8,
  toKualaLumpurBusinessDate,
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
import { IdBusinessV2ExchangeRateRepository } from './persistence/id-business-v2-exchange-rate.repository';

export interface ListIdBusinessV2ExchangeRatesQuery extends PaginationQuery {
  keyword?: string;
  recordedFrom?: string;
  recordedTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListIdBusinessV2ManualFxRatesQuery extends PaginationQuery {
  keyword?: string;
  currency?: string;
  recordedFrom?: string;
  recordedTo?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RATE = Rate8.from('9999999999.99999999');
const EXCHANGE_RATE_PATTERN = v2UnsignedDecimalPattern(V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES);
type ExchangeRateEntryRecord = NonNullable<
  Awaited<ReturnType<IdBusinessV2ExchangeRateRepository['findEntry']>>
>;
type ManualFxRateRecord = NonNullable<
  Awaited<ReturnType<IdBusinessV2ExchangeRateRepository['findManualFxRateSnapshot']>>
>;

@Injectable()
export class IdBusinessV2ExchangeRatesService {
  constructor(
    private readonly repository: IdBusinessV2ExchangeRateRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async list(query: ListIdBusinessV2ExchangeRatesQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const recordedAt = this.parseDateRange(query.recordedFrom, query.recordedTo);
    const [items, total] = await this.repository.listEntries({
      keyword,
      keywordIsUuid: Boolean(keyword && UUID_PATTERN.test(keyword)),
      recordedAt,
      skip: pagination.skip,
      take: pagination.take,
      sortBy: query.sortBy === 'createdAt' ? 'createdAt' : 'recordedAt',
      sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc'
    });

    return {
      items: items.map((entry) => this.toResponse(entry)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async getOverview() {
    const [latestEntry, total] = await Promise.all([
      this.repository.findLatestEntry(),
      this.repository.countEntries()
    ]);

    return {
      latestEntry: latestEntry ? this.toResponse(latestEntry) : null,
      total,
      calculationRule: '综合买入和综合卖出分别取 Binance 与 OKX 的算术平均值，中间价再取二者平均值'
    };
  }

  async get(idValue: string) {
    const id = this.normalizeUuid(idValue);
    const entry = await this.repository.findEntry(id);

    if (!entry) {
      throw new NotFoundException('手工汇率记录不存在');
    }

    return this.toResponse(entry);
  }

  async create(
    dto: CreateIdBusinessV2ExchangeRateEntryDto,
    operator?: AuthenticatedUser,
    requestId = 'exchange-rate-manual'
  ) {
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

    const entry = await this.transactionManager.execute(
      async (tx) => {
        const created = await this.repository.createEntry(tx, {
          binanceMerchantBuyRateToRmb: binanceMerchantBuyRateToRmb.toString(),
          binanceMerchantSellRateToRmb: binanceMerchantSellRateToRmb.toString(),
          okxMerchantBuyRateToRmb: okxMerchantBuyRateToRmb.toString(),
          okxMerchantSellRateToRmb: okxMerchantSellRateToRmb.toString(),
          combinedMerchantBuyAverageRateToRmb: combinedMerchantBuyAverageRateToRmb.toString(),
          combinedMerchantSellAverageRateToRmb: combinedMerchantSellAverageRateToRmb.toString(),
          midRateToRmb: midRateToRmb.toString(),
          recordedAt,
          remark,
          createdByUserId: operator.id
        });
        await this.audit.append(tx, {
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
        });
        return created;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return this.toResponse(entry);
  }

  async listManualFxRates(query: ListIdBusinessV2ManualFxRatesQuery) {
    const pagination = getPagination(query);
    const [items, total] = await this.repository.listManualFxRateSnapshots({
      keyword: this.normalizeKeyword(query.keyword),
      currency: this.normalizeManualCurrencyFilter(query.currency),
      recordedAt: this.parseDateRange(query.recordedFrom, query.recordedTo),
      skip: pagination.skip,
      take: pagination.take,
      sortOrder: query.sortOrder === 'asc' ? 'asc' : 'desc'
    });
    return {
      items: items.map((item) => this.manualFxRateResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async getManualFxRate(idValue: string) {
    const id = this.normalizeUuid(idValue);
    const entry = await this.repository.findManualFxRateSnapshot(id);
    if (!entry) {
      throw new NotFoundException('人工汇率记录不存在');
    }
    return this.manualFxRateResponse(entry);
  }

  async createManualFxRate(
    dto: CreateIdBusinessV2ManualFxRateDto,
    operator?: AuthenticatedUser,
    requestId = 'exchange-rate-manual-fx-rate'
  ) {
    if (!operator?.id) {
      throw new BadRequestException('无法识别当前操作人');
    }
    const currency = this.normalizeManualCurrency(dto.currency);
    const rateToCny = this.parseRate(dto.rateToCny, '交易汇率');
    const recordedAt = this.parseRecordedAt(dto.recordedAt);
    const reason = this.normalizeManualReason(dto.reason);
    const sourceReference = this.normalizeSourceReference(dto.sourceReference);

    const entry = await this.transactionManager.execute(
      async (tx) => {
        const created = await this.repository.createFinanceFxRateSnapshot(tx, {
          id: randomUUID(),
          currency,
          rateToCny: rateToCny.toString(),
          source: 'manual',
          sourceReference,
          businessDate: toKualaLumpurBusinessDate(recordedAt).date,
          capturedAt: recordedAt,
          manualReason: reason,
          createdByUserId: operator.id
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.manual.fx_rate.create',
          objectType: 'id_business_v2_finance_fx_rate_snapshot',
          objectId: created.id,
          afterData: {
            currency,
            rateToCny: rateToCny.toString(),
            recordedAt: recordedAt.toISOString(),
            reason,
            sourceReference
          },
          remark: 'V2 人工汇率按币种录入'
        });
        return created;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return this.manualFxRateResponse(entry);
  }

  private average(left: Rate8, right: Rate8) {
    return left.add(right).div(2);
  }

  private parseRate(value: unknown, label: string) {
    const normalized =
      typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';

    if (!normalized) {
      throw new BadRequestException(`${label}不能为空`);
    }
    if (!EXCHANGE_RATE_PATTERN.test(normalized)) {
      throw new BadRequestException(
        `${label}必须是最多 ${V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES} 位小数的正数`
      );
    }

    let rate: Rate8;
    try {
      rate = Rate8.from(normalized);
    } catch {
      throw new BadRequestException(`${label}格式无效`);
    }
    if (rate.lte(0)) throw new BadRequestException(`${label}必须大于 0`);
    if (rate.gt(MAX_RATE)) throw new BadRequestException(`${label}超出允许范围`);
    return rate;
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

  private normalizeManualCurrency(value: unknown) {
    const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (currency !== 'MYR' && currency !== 'USD' && currency !== 'USDT') {
      throw new BadRequestException('人工汇率币种仅支持 MYR、USD、USDT');
    }
    return currency;
  }

  private normalizeManualCurrencyFilter(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!normalized) return undefined;
    if (normalized !== 'MYR' && normalized !== 'USD' && normalized !== 'USDT') {
      throw new BadRequestException('人工汇率币种筛选无效');
    }
    return normalized;
  }

  private normalizeManualReason(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length < 2) {
      throw new BadRequestException('人工汇率原因至少填写 2 个字符');
    }
    if (normalized.length > 500) {
      throw new BadRequestException('人工汇率原因不能超过 500 个字符');
    }
    return normalized;
  }

  private normalizeSourceReference(value: unknown) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
      throw new BadRequestException('汇率来源说明格式无效');
    }
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > 500) {
      throw new BadRequestException('汇率来源说明不能超过 500 个字符');
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

  private manualFxRateResponse(entry: ManualFxRateRecord) {
    return {
      id: entry.id,
      currency: entry.currency,
      rateToCny: entry.rateToCny,
      source: entry.source,
      sourceReference: entry.sourceReference,
      businessDate: entry.businessDate.toISOString().slice(0, 10),
      recordedAt: entry.capturedAt,
      capturedAt: entry.capturedAt,
      expiresAt: entry.expiresAt,
      reason: entry.manualReason,
      createdBy: entry.createdBy,
      createdAt: entry.createdAt
    };
  }
}
