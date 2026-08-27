import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type {
  IdBusinessV2FinanceAccountCode,
  IdBusinessV2FinanceInflowNature,
  IdBusinessV2FinanceJournalType
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  buildIdBusinessV2DateRange
} from '../runtime/public-api';
import type {
  CorrectIdBusinessV2FinanceInflowDto,
  CreateIdBusinessV2FinanceInflowDto
} from './dto/id-business-v2-finance.dto';
import {
  decryptFinanceInflowReceipt,
  prepareFinanceInflowReceipt,
  type FinanceInflowReceiptUpload
} from './id-business-v2-finance-inflow-receipt';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import {
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceIdempotencyKey,
  normalizeFinanceMoney,
  normalizeFinanceRate,
  normalizeFinanceText,
  normalizeFinanceUuid,
  normalizeOptionalFinanceUuid
} from './id-business-v2-finance-input';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';

interface ListInflowQuery extends PaginationQuery {
  nature?: string;
  categoryOptionId?: string;
  financeAccountId?: string;
  currency?: string;
  dateFrom?: string;
  dateTo?: string;
}

interface InflowPostingConfig {
  label: string;
  journalType: IdBusinessV2FinanceJournalType;
  accountCode: IdBusinessV2FinanceAccountCode;
}

const INFLOW_POSTING_CONFIG: Record<IdBusinessV2FinanceInflowNature, InflowPostingConfig> = {
  operating_income: {
    label: '经营收入',
    journalType: 'manual_operating_income',
    accountCode: 'other_operating_revenue'
  },
  capital_contribution: {
    label: '股东投入',
    journalType: 'capital_contribution',
    accountCode: 'contributed_capital'
  },
  borrowed_funds: {
    label: '借入资金',
    journalType: 'borrowed_funds_received',
    accountCode: 'borrowed_funds_payable'
  }
};

@Injectable()
export class IdBusinessV2FinanceInflowsService {
  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly commandRepository: IdBusinessV2FinanceCommandRepository,
    private readonly queryRepository: IdBusinessV2FinanceQueryRepository,
    private readonly audit: V2TransactionalAuditService,
    private readonly fxService: IdBusinessV2FinanceFxService,
    private readonly postingService: IdBusinessV2FinancePostingService,
    private readonly encryption: FieldEncryptionService,
    private readonly auditLogs: AuditLogsService
  ) {}

  async list(query: ListInflowQuery) {
    const pagination = getPagination(query);
    const nature = query.nature ? normalizeInflowNature(query.nature) : undefined;
    const categoryOptionId = query.categoryOptionId
      ? normalizeFinanceUuid(query.categoryOptionId, '收入分类')
      : undefined;
    const financeAccountId = query.financeAccountId
      ? normalizeFinanceUuid(query.financeAccountId, '资金账户')
      : undefined;
    const currency = query.currency ? normalizeFinanceCurrency(query.currency) : undefined;
    const occurredAt = this.parseDateRange(query.dateFrom, query.dateTo);
    const result = await this.queryRepository.listInflows(
      { nature, categoryOptionId, financeAccountId, currency, occurredAt },
      pagination.skip,
      pagination.take
    );
    const summary = new Map(result.summary.map((item) => [item.nature, item.amountCny]));
    const operatingIncomeCny = summary.get('operating_income') ?? '0';
    const capitalContributionCny = summary.get('capital_contribution') ?? '0';
    const borrowedFundsCny = summary.get('borrowed_funds') ?? '0';
    return {
      items: result.items.map((item) => this.toResponse(item)),
      total: result.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      summary: {
        operatingIncomeCny,
        capitalContributionCny,
        borrowedFundsCny,
        totalInflowCny: [operatingIncomeCny, capitalContributionCny, borrowedFundsCny]
          .reduce((sum, value) => sum.add(value), Amount4.zero())
          .toString()
      }
    };
  }

  create(
    dto: CreateIdBusinessV2FinanceInflowDto,
    operator?: AuthenticatedUser,
    receipt?: FinanceInflowReceiptUpload
  ) {
    return this.write(dto, null, null, operator, receipt);
  }

  correct(
    inflowIdValue: string,
    dto: CorrectIdBusinessV2FinanceInflowDto,
    operator?: AuthenticatedUser,
    receipt?: FinanceInflowReceiptUpload
  ) {
    const inflowId = normalizeFinanceUuid(inflowIdValue, '资金流入');
    const reason = normalizeFinanceText(dto.reason, '更正原因', 500, true)!;
    return this.write(dto, inflowId, reason, operator, receipt);
  }

  async downloadReceipt(inflowIdValue: string, operator?: AuthenticatedUser) {
    const inflowId = normalizeFinanceUuid(inflowIdValue, '资金流入');
    const inflow = await this.queryRepository.findInflowReceipt(inflowId);
    if (!inflow) throw new NotFoundException('资金流入记录不存在');
    if (!inflow.receiptAttachment) throw new NotFoundException('该收入记录没有收款凭证');
    const content = decryptFinanceInflowReceipt(inflow.receiptAttachment, this.encryption);
    await this.auditLogs.create({
      userId: operator?.id,
      module: 'id_business_v2_finance',
      action: 'id_business_v2.finance_inflow.receipt_view',
      objectType: 'id_business_v2_finance_inflow',
      objectId: inflow.id,
      afterData: {
        attachmentId: inflow.receiptAttachment.id,
        originalName: inflow.receiptAttachment.originalName,
        contentSha256: inflow.receiptAttachment.contentSha256
      },
      remark: `查看资金流入收款凭证：${inflow.receiptAttachment.originalName}`
    });
    return {
      content,
      originalName: inflow.receiptAttachment.originalName,
      mimeType: inflow.receiptAttachment.mimeType
    };
  }

  private async write(
    dto: CreateIdBusinessV2FinanceInflowDto,
    correctedInflowId: string | null,
    correctionReason: string | null,
    operator?: AuthenticatedUser,
    receipt?: FinanceInflowReceiptUpload
  ) {
    const nature = normalizeInflowNature(dto.nature);
    const config = INFLOW_POSTING_CONFIG[nature];
    const categoryOptionId =
      nature === 'operating_income' ? normalizeFinanceUuid(dto.categoryOptionId, '收入分类') : null;
    if (nature !== 'operating_income' && dto.categoryOptionId) {
      throw new BadRequestException(`${config.label}不能选择经营收入分类`);
    }
    const financeAccountId = normalizeFinanceUuid(dto.financeAccountId, '资金账户');
    const currency = normalizeFinanceCurrency(dto.currency);
    const amount = normalizeFinanceMoney(dto.amount, '入账金额');
    const occurredAt = normalizeFinanceDate(dto.occurredAt, '发生时间');
    const manualRate =
      dto.fxRateToCny === undefined ? null : normalizeFinanceRate(dto.fxRateToCny, currency);
    const payerLabel =
      nature === 'capital_contribution'
        ? '出资人'
        : nature === 'borrowed_funds'
          ? '出借人'
          : '付款方';
    const payer = normalizeFinanceText(dto.payer, payerLabel, 200, nature !== 'operating_income');
    const externalReference = normalizeFinanceText(dto.externalReference, '收款流水号', 200, true)!;
    const normalizedReference = normalizeInflowReference(externalReference);
    const remark = normalizeFinanceText(dto.remark, '备注', 2000);
    const requestedReceiptAttachmentId = normalizeOptionalFinanceUuid(
      dto.receiptAttachmentId,
      '收款凭证'
    );
    const preparedReceipt = prepareFinanceInflowReceipt(receipt, this.encryption);
    if (!correctedInflowId && requestedReceiptAttachmentId && !preparedReceipt) {
      throw new BadRequestException('新收入请直接上传收款凭证');
    }
    if (!correctedInflowId && !preparedReceipt) {
      throw new BadRequestException('请上传收款凭证');
    }
    const baseIdempotencyKey = normalizeFinanceIdempotencyKey(
      dto.idempotencyKey,
      correctedInflowId ? 'finance_inflow_correction' : 'finance_inflow'
    );
    const idempotencyKey = correctedInflowId
      ? `${baseIdempotencyKey}:replacement`
      : baseIdempotencyKey;

    const [{ category, account }, rate, orderConflict] = await Promise.all([
      this.queryRepository.findInflowPrerequisites(categoryOptionId, financeAccountId),
      this.fxService.resolve({
        currency,
        occurredAt,
        fxRateSnapshotId: dto.fxRateSnapshotId,
        manualRate,
        manualReason: dto.manualRateReason,
        operator
      }),
      nature === 'operating_income'
        ? this.queryRepository.findOrderIncomeReferenceConflict(externalReference)
        : null
    ]);
    if (orderConflict) {
      throw new ConflictException(
        `收款流水号已属于订单 ${orderConflict.orderNo}，不能再手工记为经营收入`
      );
    }
    if (nature === 'operating_income' && !category) {
      throw new BadRequestException('收入分类不存在或已停用');
    }
    if (!account || account.status !== 'active') {
      throw new BadRequestException('资金账户不存在或已停用');
    }
    if (account.currency !== currency) {
      throw new BadRequestException('入账币种与资金账户币种不一致');
    }
    const rateToCny = Rate8.from(rate.rateToCny);
    const amountCny = rateToCny.apply(amount);
    const summaryLabel = category?.name ?? payer ?? config.label;

    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.commandRepository.findInflowReplay(tx, idempotencyKey);
      if (replay) return this.toResponse(replay);

      let reversalJournalId: string | null = null;
      let original: Awaited<
        ReturnType<IdBusinessV2FinanceCommandRepository['findInflowForCorrection']>
      > = null;
      if (correctedInflowId) {
        original = await this.commandRepository.findInflowForCorrection(tx, correctedInflowId);
        if (!original) throw new NotFoundException('资金流入记录不存在');
        if (original.journal.status === 'reversed') {
          throw new ConflictException('该资金流入已冲销，不能重复更正');
        }
      }

      const originalReference = original?.externalReference
        ? normalizeInflowReference(original.externalReference)
        : null;
      const reservedReference = await this.commandRepository.findIncomeReference(
        tx,
        normalizedReference
      );
      const correctionOwnsReference =
        originalReference === normalizedReference && reservedReference?.sourceType === 'inflow';
      if (reservedReference && !correctionOwnsReference) {
        throw new ConflictException('该收款流水号已被其他收入记录使用');
      }

      let receiptAttachmentId = preparedReceipt?.id ?? requestedReceiptAttachmentId;
      if (original) {
        if (
          !preparedReceipt &&
          requestedReceiptAttachmentId &&
          requestedReceiptAttachmentId !== original.receiptAttachmentId
        ) {
          throw new BadRequestException('更正收款凭证时请重新上传文件');
        }
        receiptAttachmentId = preparedReceipt?.id ?? original.receiptAttachmentId;
      }
      if (!receiptAttachmentId) throw new BadRequestException('请上传收款凭证');

      const inflowId = randomUUID();
      if (preparedReceipt) {
        await this.commandRepository.createAttachment(tx, {
          ...preparedReceipt,
          businessModule: 'id_business_v2_finance',
          objectType: 'id_business_v2_finance_inflow',
          objectId: inflowId,
          purpose: 'finance_inflow_receipt',
          createdByUserId: operator?.id
        });
      }

      if (original) {
        const reversal = await this.postingService.reverse(
          tx,
          original.journalId,
          correctionReason!,
          `${baseIdempotencyKey}:reversal`,
          operator
        );
        reversalJournalId = reversal.id;
      }

      const journal = await this.postingService.post(tx, {
        journalType: config.journalType,
        sourceType: 'inflow',
        sourceId: inflowId,
        sourceReference: externalReference ?? payer ?? summaryLabel,
        occurredAt,
        summary: `${config.label}：${summaryLabel}`,
        metadata: {
          payer,
          externalReference,
          receiptAttachmentId,
          correctedInflowId,
          reversalJournalId,
          correctionReason
        },
        idempotencyKey: `${idempotencyKey}:journal`,
        operator,
        lines: [
          {
            accountCode: 'cash',
            direction: 'debit',
            currency,
            amountOriginal: amount,
            fxRateToCny: rateToCny,
            amountCny,
            financeAccountId,
            fxRateSnapshotId: rate.id,
            memo: account.name
          },
          {
            accountCode: config.accountCode,
            direction: 'credit',
            currency,
            amountOriginal: amount,
            fxRateToCny: rateToCny,
            amountCny,
            fxRateSnapshotId: rate.id,
            memo: summaryLabel
          }
        ]
      });
      const inflow = await this.commandRepository.createInflow(tx, {
        id: inflowId,
        journalId: journal.id,
        nature,
        categoryOptionId,
        categoryNameSnapshot: category?.name ?? null,
        financeAccountId,
        financeAccountNameSnapshot: account.name,
        fxRateSnapshotId: rate.id,
        currency,
        amountOriginal: amount.toString(),
        fxRateToCny: rateToCny.toString(),
        amountCny: amountCny.toString(),
        occurredAt,
        payer,
        externalReference,
        receiptAttachmentId,
        remark,
        idempotencyKey,
        createdByUserId: operator?.id
      });
      if (!reservedReference) {
        await this.commandRepository.createInflowIncomeReference(
          tx,
          normalizedReference,
          inflow.id
        );
      }
      await this.audit.append(tx, {
        userId: operator?.id,
        module: 'id_business_v2_finance',
        action: correctedInflowId
          ? 'id_business_v2.finance_inflow.correct'
          : 'id_business_v2.finance_inflow.create',
        objectType: 'id_business_v2_finance_inflow',
        objectId: correctedInflowId ?? inflow.id,
        beforeData: original
          ? {
              journalId: original.journalId,
              nature: original.nature,
              categoryOptionId: original.categoryOptionId,
              financeAccountId: original.financeAccountId,
              currency: original.currency,
              amount: original.amountOriginal,
              occurredAt: original.occurredAt.toISOString(),
              externalReference: original.externalReference,
              receiptAttachmentId: original.receiptAttachmentId
            }
          : undefined,
        afterData: {
          inflowId: inflow.id,
          journalId: inflow.journalId,
          reversalJournalId,
          nature,
          categoryOptionId,
          financeAccountId,
          currency,
          amount: amount.toString(),
          amountCny: amountCny.toString(),
          occurredAt: occurredAt.toISOString(),
          externalReference,
          receiptAttachmentId,
          receiptOriginalName: preparedReceipt?.originalName ?? null,
          receiptContentSha256: preparedReceipt?.contentSha256 ?? null,
          correctionReason
        },
        remark: correctedInflowId
          ? `更正资金流入：${summaryLabel}`
          : `记录资金流入：${summaryLabel}`
      });
      return this.toResponse(inflow);
    }, this.commandOptions(operator));
  }

  private toResponse(item: {
    id: string;
    journalId: string;
    nature: IdBusinessV2FinanceInflowNature;
    categoryOptionId: string | null;
    categoryNameSnapshot: string | null;
    financeAccountId: string;
    financeAccountNameSnapshot: string;
    currency: string;
    amountOriginal: string;
    fxRateToCny: string;
    amountCny: string;
    occurredAt: Date;
    payer: string | null;
    externalReference: string;
    receiptAttachmentId: string;
    receiptAttachment: {
      id: string;
      originalName: string;
      mimeType: string;
      sizeBytes: bigint;
      contentSha256: string | null;
    };
    remark: string | null;
    createdAt: Date;
    journal: { status: string };
    createdBy?: { id: string; username: string; displayName: string } | null;
  }) {
    return {
      id: item.id,
      journalId: item.journalId,
      nature: item.nature,
      categoryOptionId: item.categoryOptionId,
      categoryName: item.categoryNameSnapshot,
      financeAccountId: item.financeAccountId,
      financeAccountName: item.financeAccountNameSnapshot,
      currency: item.currency,
      amountOriginal: item.amountOriginal,
      fxRateToCny: item.fxRateToCny,
      amountCny: item.amountCny,
      occurredAt: item.occurredAt,
      payer: item.payer,
      externalReference: item.externalReference,
      receiptAttachmentId: item.receiptAttachmentId,
      receiptAttachment: item.receiptAttachment
        ? {
            id: item.receiptAttachment.id,
            originalName: item.receiptAttachment.originalName,
            mimeType: item.receiptAttachment.mimeType,
            sizeBytes: item.receiptAttachment.sizeBytes.toString(),
            contentSha256: item.receiptAttachment.contentSha256
          }
        : null,
      remark: item.remark,
      status: item.journal.status,
      createdBy: item.createdBy ?? null,
      createdAt: item.createdAt
    };
  }

  private parseDateRange(from?: string, to?: string) {
    return buildIdBusinessV2DateRange(from, to, {
      from: '开始日期',
      to: '结束日期',
      invalidRange: '开始日期不能晚于结束日期'
    });
  }

  private commandOptions(operator?: AuthenticatedUser) {
    return {
      changedScopes: ['finance-ledger'],
      requestId: randomUUID(),
      operator,
      uniqueConflictMessage: '该收款流水号已被使用，或收入记录已被其他操作更正'
    } as const;
  }
}

function normalizeInflowReference(value: string) {
  return value.trim().toLowerCase();
}

function normalizeInflowNature(value: unknown): IdBusinessV2FinanceInflowNature {
  if (
    value !== 'operating_income' &&
    value !== 'capital_contribution' &&
    value !== 'borrowed_funds'
  ) {
    throw new BadRequestException('资金性质不正确');
  }
  return value;
}
