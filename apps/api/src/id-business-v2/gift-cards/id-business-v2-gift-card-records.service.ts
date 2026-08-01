import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { randomUUID } from 'node:crypto';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination } from '../../common/pagination';
import { IdBusinessV2OptionsService } from '../options/public-api';
import { V2CommandTransactionManager } from '../runtime/public-api';
import type { UpdateIdBusinessV2GiftCardMetadataDto } from './dto/update-id-business-v2-gift-card-metadata.dto';
import {
  type BalanceLedgerRecord,
  type GiftCardRecord,
  type IdBusinessV2BalanceLedgerEntryType,
  type IdBusinessV2GiftCardStatus
} from './id-business-v2-gift-card-record-includes';
import type {
  ListIdBusinessV2BalanceLedgerQuery,
  ListIdBusinessV2GiftCardRecordsQuery
} from './id-business-v2-gift-card-record-query';
import { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

export type {
  ListIdBusinessV2BalanceLedgerQuery,
  ListIdBusinessV2GiftCardRecordsQuery
} from './id-business-v2-gift-card-record-query';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const GIFT_CARD_SORT_FIELDS: Record<string, string> = {
  faceValue: 'faceValue',
  exchangeRate: 'exchangeRate',
  costAmount: 'costAmount',
  status: 'status',
  statusChangedAt: 'statusChangedAt',
  creditedAt: 'creditedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

const LEDGER_SORT_FIELDS: Record<string, string> = {
  balanceAmount: 'balanceAmount',
  costAmount: 'costAmount',
  balanceAfter: 'balanceAfter',
  costAfter: 'costAfter',
  createdAt: 'createdAt'
};

@Injectable()
export class IdBusinessV2GiftCardRecordsService {
  constructor(
    private readonly repository: IdBusinessV2GiftCardsRepository,
    private readonly optionsService: IdBusinessV2OptionsService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async listGiftCards(query: ListIdBusinessV2GiftCardRecordsQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const accountId = this.normalizeOptionalUuid(query.accountId, '目标 ID');
    const cardNameOptionId = this.normalizeOptionalUuid(query.cardNameOptionId, '卡片名称');
    const countryOptionId = this.normalizeOptionalUuid(query.countryOptionId, '国家');
    const supplierOptionId = this.normalizeOptionalUuid(query.supplierOptionId, '供应商');
    const status = this.parseGiftCardStatus(query.status);
    const { items, total } = await this.repository.listGiftCards({
      accountId,
      cardNameOptionId,
      supplierOptionId,
      countryOptionId,
      status,
      creditedAt: this.parseDateRange(query.dateFrom, query.dateTo),
      keyword,
      sortField: this.resolveSortField(query, GIFT_CARD_SORT_FIELDS, 'creditedAt'),
      sortDirection: query.sortOrder === 'asc' ? 'asc' : 'desc',
      skip: pagination.skip,
      take: pagination.take
    });

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
    const { items, total } = await this.repository.listBalanceLedger({
      accountId,
      countryOptionId,
      supplierOptionId,
      entryType,
      createdAt: this.parseDateRange(query.dateFrom, query.dateTo),
      keyword,
      sortField: this.resolveSortField(query, LEDGER_SORT_FIELDS, 'createdAt'),
      sortDirection: query.sortOrder === 'asc' ? 'asc' : 'desc',
      skip: pagination.skip,
      take: pagination.take
    });

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

    return this.transactionManager.execute(
      async (tx) => {
        const existing = await this.repository.findMetadataInTransaction(tx, giftCardId);
        if (!existing) {
          throw new NotFoundException('礼品卡记录不存在');
        }
        if (existing.account.lossReportedAt) {
          throw new ConflictException('已报损 ID 永久冻结，不能修改加卡记录');
        }

        const updated = await this.repository.updateMetadataInTransaction(tx, {
          giftCardId,
          remark,
          updatedByUserId: operator?.id
        });
        await this.repository.appendAudit(tx, {
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
        });

        return this.toGiftCardResponse(updated);
      },
      {
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }

  private toGiftCardResponse(item: GiftCardRecord) {
    const creditedLedger = item.ledgerEntries[0] ?? null;
    const hasSupplierFunding = Boolean(item.supplierFundEntries[0]);
    return {
      id: item.id,
      cardNameOptionId: item.cardNameOptionId,
      cardName: {
        ...item.cardNameOption,
        name: item.cardNameSnapshot
      },
      code: this.decryptGiftCardCode(item.codeEncrypted),
      codeMasked: item.codeMasked,
      codeTail: item.codeTail,
      faceValue: item.faceValue.toString(),
      exchangeRate: item.exchangeRate.toString(),
      exchangeRateSource: item.exchangeRateSource,
      exchangeRateSnapshotId: item.exchangeRateSnapshotId,
      exchangeRatePrefilledValue:
        item.exchangeRatePrefilledValue == null ? null : item.exchangeRatePrefilledValue.toString(),
      exchangeRateWasOverridden: item.exchangeRateWasOverridden,
      costAmount: item.costAmount.toString(),
      purchaseOriginalAmount: item.purchaseOriginalAmount.toString(),
      purchaseCurrency: item.purchaseCurrency ?? ('CNY' as const),
      purchaseFxRateToCny: item.purchaseFxRateToCny.toString(),
      purchaseFxSnapshotId: item.purchaseFxSnapshotId ?? null,
      purchaseFinanceAccountId: item.purchaseFinanceAccountId ?? null,
      purchaseSupplierAccountId: item.purchaseSupplierAccountId ?? null,
      paidAt: item.paidAt ?? null,
      creditedAt: item.creditedAt,
      supplierRefundStatus: item.supplierRefundStatus ?? ('none' as const),
      supplierRefundAmount: item.supplierRefundAmount.toString(),
      supplierRefundAmountCny: item.supplierRefundAmountCny.toString(),
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
            balanceBefore: creditedLedger.balanceBefore.toString(),
            balanceAfter: creditedLedger.balanceAfter.toString(),
            costBefore: creditedLedger.costBefore.toString(),
            costAfter: creditedLedger.costAfter.toString(),
            averageCostBefore: creditedLedger.averageCostBefore.toString(),
            averageCostAfter: creditedLedger.averageCostAfter.toString(),
            createdAt: creditedLedger.createdAt
          }
        : null,
      hasSupplierFunding,
      reversal: creditedLedger?.reversedByEntry
        ? {
            id: creditedLedger.reversedByEntry.id,
            entryType: creditedLedger.reversedByEntry.entryType,
            balanceAmount: creditedLedger.reversedByEntry.balanceAmount.toString(),
            costAmount: creditedLedger.reversedByEntry.costAmount.toString(),
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
    const { balanceAmount, costAmount, balanceBefore, balanceAfter, costBefore, costAfter } = item;
    return {
      id: item.id,
      entryType: item.entryType,
      direction: item.direction,
      balanceAmount: balanceAmount.toString(),
      costAmount: costAmount.toString(),
      balanceDelta: balanceAfter.sub(balanceBefore).toString(),
      costDelta: costAfter.sub(costBefore).toString(),
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      costBefore: costBefore.toString(),
      costAfter: costAfter.toString(),
      averageCostBefore: item.averageCostBefore.toString(),
      averageCostAfter: item.averageCostAfter.toString(),
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
            faceValue: item.giftCard.faceValue.toString(),
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

  private resolveSortField(
    query: { sortBy?: string; sortOrder?: string },
    fields: Record<string, string>,
    fallback: string
  ) {
    const field = fields[query.sortBy ?? fallback] ?? fallback;
    return field;
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
