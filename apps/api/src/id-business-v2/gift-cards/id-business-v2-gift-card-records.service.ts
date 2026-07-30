import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type {
  IdBusinessV2BalanceLedgerEntryType,
  IdBusinessV2GiftCardStatus,
  Prisma
} from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';
import { IdBusinessV2OptionsService } from '../options/public-api';
import type { UpdateIdBusinessV2GiftCardMetadataDto } from './dto/update-id-business-v2-gift-card-metadata.dto';
import {
  BALANCE_LEDGER_INCLUDE,
  GIFT_CARD_RECORD_INCLUDE,
  type BalanceLedgerRecord,
  type GiftCardRecord
} from './id-business-v2-gift-card-record-includes';

export interface ListIdBusinessV2GiftCardRecordsQuery extends PaginationQuery {
  keyword?: string;
  accountId?: string;
  countryOptionId?: string;
  supplierOptionId?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface ListIdBusinessV2BalanceLedgerQuery extends PaginationQuery {
  keyword?: string;
  accountId?: string;
  countryOptionId?: string;
  supplierOptionId?: string;
  entryType?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const GIFT_CARD_SORT_FIELDS: Record<
  string,
  keyof Prisma.IdBusinessV2GiftCardOrderByWithRelationInput
> = {
  faceValue: 'faceValue',
  exchangeRate: 'exchangeRate',
  costAmount: 'costAmount',
  status: 'status',
  statusChangedAt: 'statusChangedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

const LEDGER_SORT_FIELDS: Record<
  string,
  keyof Prisma.IdBusinessV2BalanceLedgerOrderByWithRelationInput
> = {
  balanceAmount: 'balanceAmount',
  costAmount: 'costAmount',
  balanceAfter: 'balanceAfter',
  costAfter: 'costAfter',
  createdAt: 'createdAt'
};

@Injectable()
export class IdBusinessV2GiftCardRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly optionsService: IdBusinessV2OptionsService,
    private readonly fieldEncryptionService: FieldEncryptionService
  ) {}

  async listGiftCards(query: ListIdBusinessV2GiftCardRecordsQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const accountId = this.normalizeOptionalUuid(query.accountId, '目标 ID');
    const countryOptionId = this.normalizeOptionalUuid(query.countryOptionId, '国家');
    const supplierOptionId = this.normalizeOptionalUuid(query.supplierOptionId, '供应商');
    const status = this.parseGiftCardStatus(query.status);
    const where: Prisma.IdBusinessV2GiftCardWhereInput = {
      accountId: accountId ?? undefined,
      supplierOptionId: supplierOptionId ?? undefined,
      countryOptionId: countryOptionId ?? undefined,
      status: status ?? undefined,
      statusChangedAt: this.parseDateRange(query.dateFrom, query.dateTo),
      OR: keyword
        ? [
            { codeMasked: { contains: keyword, mode: 'insensitive' } },
            { codeTail: { contains: keyword.slice(-8), mode: 'insensitive' } },
            {
              account: {
                is: {
                  appleIdMasked: { contains: keyword, mode: 'insensitive' }
                }
              }
            },
            {
              supplierOption: {
                is: {
                  name: { contains: keyword, mode: 'insensitive' }
                }
              }
            }
          ]
        : undefined
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2GiftCard.findMany({
        where,
        include: GIFT_CARD_RECORD_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query, GIFT_CARD_SORT_FIELDS, 'statusChangedAt')
      }),
      this.prisma.idBusinessV2GiftCard.count({ where })
    ]);

    return {
      items: items.map((item) => this.toGiftCardResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async listBalanceLedger(query: ListIdBusinessV2BalanceLedgerQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const accountId = this.normalizeOptionalUuid(query.accountId, '目标 ID');
    const countryOptionId = this.normalizeOptionalUuid(query.countryOptionId, '国家');
    const supplierOptionId = this.normalizeOptionalUuid(query.supplierOptionId, '供应商');
    const entryType = this.parseEntryType(query.entryType);
    const where: Prisma.IdBusinessV2BalanceLedgerWhereInput = {
      accountId: accountId ?? undefined,
      entryType: entryType ?? undefined,
      createdAt: this.parseDateRange(query.dateFrom, query.dateTo),
      account: countryOptionId
        ? {
            is: {
              countryOptionId
            }
          }
        : undefined,
      giftCard: supplierOptionId
        ? {
            is: {
              supplierOptionId
            }
          }
        : undefined,
      OR: keyword
        ? [
            {
              account: {
                is: {
                  appleIdMasked: { contains: keyword, mode: 'insensitive' }
                }
              }
            },
            {
              giftCard: {
                is: {
                  codeMasked: { contains: keyword, mode: 'insensitive' }
                }
              }
            },
            {
              giftCard: {
                is: {
                  codeTail: { contains: keyword.slice(-8), mode: 'insensitive' }
                }
              }
            },
            {
              giftCard: {
                is: {
                  supplierOption: {
                    is: {
                      name: { contains: keyword, mode: 'insensitive' }
                    }
                  }
                }
              }
            }
          ]
        : undefined
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2BalanceLedger.findMany({
        where,
        include: BALANCE_LEDGER_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query, LEDGER_SORT_FIELDS, 'createdAt')
      }),
      this.prisma.idBusinessV2BalanceLedger.count({ where })
    ]);

    return {
      items: items.map((item) => this.toLedgerResponse(item)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async updateMetadata(
    giftCardIdValue: string,
    dto: UpdateIdBusinessV2GiftCardMetadataDto,
    operator?: AuthenticatedUser
  ) {
    const giftCardId = this.normalizeRequiredUuid(giftCardIdValue, '礼品卡');
    if (dto.supplierOptionId === undefined && dto.remark === undefined) {
      throw new BadRequestException('至少提交一个可修改字段');
    }
    if (dto.supplierOptionId !== undefined) {
      await this.optionsService.requireActiveOption(
        dto.supplierOptionId,
        'topup_supplier',
        '加卡供应商',
        true
      );
      throw new BadRequestException('供应商不能作为普通信息修改，请使用“更正供应商”操作');
    }
    const remark =
      dto.remark === undefined ? undefined : this.normalizeRemark(dto.remark, '备注', 2000);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.idBusinessV2GiftCard.findUnique({
        where: { id: giftCardId },
        select: {
          id: true,
          codeMasked: true,
          supplierOptionId: true,
          remark: true,
          account: {
            select: {
              lossReportedAt: true
            }
          }
        }
      });
      if (!existing) {
        throw new NotFoundException('礼品卡记录不存在');
      }
      if (existing.account.lossReportedAt) {
        throw new ConflictException('已报损 ID 永久冻结，不能修改加卡记录');
      }

      const updated = await tx.idBusinessV2GiftCard.update({
        where: { id: giftCardId },
        data: {
          remark,
          updatedByUserId: operator?.id
        },
        include: GIFT_CARD_RECORD_INCLUDE
      });
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2',
          action: 'id_business_v2.gift_card.metadata_update',
          objectType: 'id_business_v2_gift_card',
          objectId: giftCardId,
          beforeData: {
            supplierOptionId: existing.supplierOptionId,
            remark: existing.remark
          },
          afterData: {
            supplierOptionId: updated.supplierOptionId,
            remark: updated.remark,
            financialFieldsChanged: false
          },
          remark: `V2 礼品卡非账务信息修改：${existing.codeMasked}`
        }
      });

      return this.toGiftCardResponse(updated);
    });
  }

  private toGiftCardResponse(item: GiftCardRecord) {
    const creditedLedger = item.ledgerEntries[0] ?? null;
    const supplierFunding = item.supplierFundEntries[0] ?? null;
    return {
      id: item.id,
      code: this.decryptGiftCardCode(item.codeEncrypted),
      codeMasked: item.codeMasked,
      codeTail: item.codeTail,
      faceValue: toV2DecimalString(item.faceValue),
      exchangeRate: toV2DecimalString(item.exchangeRate),
      exchangeRateSource: item.exchangeRateSource,
      exchangeRateSnapshotId: item.exchangeRateSnapshotId,
      exchangeRatePrefilledValue:
        item.exchangeRatePrefilledValue == null
          ? null
          : toV2DecimalString(item.exchangeRatePrefilledValue),
      exchangeRateWasOverridden: item.exchangeRateWasOverridden,
      costAmount: toV2DecimalString(item.costAmount),
      purchaseOriginalAmount: toV2DecimalString(item.purchaseOriginalAmount ?? item.costAmount),
      purchaseCurrency: item.purchaseCurrency ?? ('CNY' as const),
      purchaseFxRateToCny: (item.purchaseFxRateToCny ?? 1).toString(),
      purchaseFxSnapshotId: item.purchaseFxSnapshotId ?? null,
      purchaseFinanceAccountId: item.purchaseFinanceAccountId ?? null,
      purchaseSupplierAccountId: item.purchaseSupplierAccountId ?? null,
      paidAt: item.paidAt ?? item.createdAt,
      supplierRefundStatus: item.supplierRefundStatus ?? ('none' as const),
      supplierRefundAmount: toV2DecimalString(item.supplierRefundAmount ?? 0),
      supplierRefundAmountCny: toV2DecimalString(item.supplierRefundAmountCny ?? 0),
      supplierRefundClosedAt: item.supplierRefundClosedAt ?? null,
      status: item.status,
      statusChangedAt: item.statusChangedAt,
      supplierOptionId: item.supplierOptionId,
      supplier: item.supplierOption
        ? {
            ...item.supplierOption,
            name: item.supplierNameSnapshot ?? item.supplierOption.name
          }
        : null,
      country: {
        id: item.countryOptionId,
        code: item.countryOption.code,
        name: item.countryNameSnapshot,
        currencyCode: item.currencyCodeSnapshot
      },
      account: {
        id: item.account.id,
        appleIdMasked: item.account.appleIdMasked,
        lossStatus: item.account.lossReportedAt ? ('reported' as const) : ('active' as const),
        lossReportedAt: item.account.lossReportedAt,
        country: item.account.countryOption
      },
      creditedLedger: creditedLedger
        ? {
            id: creditedLedger.id,
            balanceBefore: toV2DecimalString(creditedLedger.balanceBefore),
            balanceAfter: toV2DecimalString(creditedLedger.balanceAfter),
            costBefore: toV2DecimalString(creditedLedger.costBefore),
            costAfter: toV2DecimalString(creditedLedger.costAfter),
            averageCostBefore: toV2DecimalString(creditedLedger.averageCostBefore),
            averageCostAfter: toV2DecimalString(creditedLedger.averageCostAfter),
            createdAt: creditedLedger.createdAt
          }
        : null,
      supplierFunding: supplierFunding
        ? {
            ledgerEntryId: supplierFunding.id,
            supplierName: supplierFunding.supplierNameSnapshot,
            amountCny: toV2DecimalString(supplierFunding.amountCny),
            balanceBeforeCny: toV2DecimalString(supplierFunding.balanceBeforeCny),
            balanceAfterCny: toV2DecimalString(supplierFunding.balanceAfterCny),
            reversed: Boolean(supplierFunding.reversedBy),
            createdAt: supplierFunding.createdAt
          }
        : null,
      reversal: creditedLedger?.reversedByEntry
        ? {
            id: creditedLedger.reversedByEntry.id,
            entryType: creditedLedger.reversedByEntry.entryType,
            balanceAmount: toV2DecimalString(creditedLedger.reversedByEntry.balanceAmount),
            costAmount: toV2DecimalString(creditedLedger.reversedByEntry.costAmount),
            reason: creditedLedger.reversedByEntry.remark,
            createdAt: creditedLedger.reversedByEntry.createdAt
          }
        : null,
      remark: item.remark,
      hasSourceAttachment: Boolean(item.sourceAttachmentId),
      createdBy: item.createdBy,
      updatedBy: item.updatedBy,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  }

  private toLedgerResponse(item: BalanceLedgerRecord) {
    return {
      id: item.id,
      entryType: item.entryType,
      direction: item.direction,
      balanceAmount: toV2DecimalString(item.balanceAmount),
      costAmount: toV2DecimalString(item.costAmount),
      balanceDelta: toV2DecimalString(item.balanceAfter.minus(item.balanceBefore)),
      costDelta: toV2DecimalString(item.costAfter.minus(item.costBefore)),
      balanceBefore: toV2DecimalString(item.balanceBefore),
      balanceAfter: toV2DecimalString(item.balanceAfter),
      costBefore: toV2DecimalString(item.costBefore),
      costAfter: toV2DecimalString(item.costAfter),
      averageCostBefore: toV2DecimalString(item.averageCostBefore),
      averageCostAfter: toV2DecimalString(item.averageCostAfter),
      reason: item.remark,
      account: {
        id: item.account.id,
        appleIdMasked: item.account.appleIdMasked,
        country: item.account.countryOption
      },
      giftCard: item.giftCard
        ? {
            id: item.giftCard.id,
            code: this.decryptGiftCardCode(item.giftCard.codeEncrypted),
            codeMasked: item.giftCard.codeMasked,
            codeTail: item.giftCard.codeTail,
            faceValue: toV2DecimalString(item.giftCard.faceValue),
            status: item.giftCard.status,
            supplier: item.giftCard.supplierOption
          }
        : null,
      reversalOf: item.reversalOfEntry,
      reversedBy: item.reversedByEntry,
      operator: item.createdBy,
      createdAt: item.createdAt
    };
  }

  private decryptGiftCardCode(codeEncrypted: string) {
    const code = this.fieldEncryptionService.decrypt(codeEncrypted);
    if (!code) throw new NotFoundException('礼品卡号不可用');
    return code;
  }

  private parseGiftCardStatus(value: unknown): IdBusinessV2GiftCardStatus | null {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (normalized === 'credited' || normalized === 'redeemed' || normalized === 'withdrawn') {
      return normalized;
    }
    throw new BadRequestException('礼品卡状态无效');
  }

  private parseEntryType(value: unknown): IdBusinessV2BalanceLedgerEntryType | null {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (
      normalized === 'gift_card_credit' ||
      normalized === 'gift_card_redeemed' ||
      normalized === 'gift_card_withdrawal' ||
      normalized === 'account_loss'
    ) {
      return normalized;
    }
    throw new BadRequestException('余额变动类型无效');
  }

  private parseDateRange(dateFromValue: unknown, dateToValue: unknown) {
    const dateFrom = this.parseDate(dateFromValue, '开始日期', false);
    const dateTo = this.parseDate(dateToValue, '结束日期', true);
    if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
      throw new BadRequestException('开始日期不能晚于结束日期');
    }
    if (!dateFrom && !dateTo) return undefined;
    return {
      gte: dateFrom ?? undefined,
      lte: dateTo ?? undefined
    };
  }

  private parseDate(value: unknown, label: string, endOfDay: boolean) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) return null;
    if (!DATE_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    const date = new Date(`${normalized}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return date;
  }

  private buildOrderBy(
    query: { sortBy?: string; sortOrder?: string },
    fields: Record<string, string>,
    fallback: string
  ) {
    const field = fields[query.sortBy ?? fallback] ?? fallback;
    const direction = query.sortOrder === 'asc' ? 'asc' : 'desc';
    return [{ [field]: direction }, { id: 'desc' }] as Array<Record<string, 'asc' | 'desc'>>;
  }

  private normalizeKeyword(value: unknown) {
    const normalized = this.normalizeNullableString(value);
    if (normalized && normalized.length > 120) {
      throw new BadRequestException('搜索关键词不能超过 120 个字符');
    }
    return normalized;
  }

  private normalizeOptionalUuid(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    return normalized ? this.normalizeRequiredUuid(normalized, label) : null;
  }

  private normalizeRequiredUuid(value: unknown, label: string) {
    const normalized = this.normalizeNullableString(value);
    if (!normalized || !UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  private normalizeRemark(value: unknown, label: string, maximumLength: number) {
    const normalized = this.normalizeNullableString(value);
    if (normalized && normalized.length > maximumLength) {
      throw new BadRequestException(`${label}不能超过 ${maximumLength} 个字符`);
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
}
