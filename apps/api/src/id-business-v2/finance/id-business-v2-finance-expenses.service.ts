import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal, toV2DecimalString } from '../decimal-policy';
import type { CreateIdBusinessV2FinanceExpenseDto } from './dto/id-business-v2-finance.dto';
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

interface ListExpenseQuery extends PaginationQuery {
  categoryOptionId?: string;
  financeAccountId?: string;
  currency?: string;
  dateFrom?: string;
  dateTo?: string;
}

@Injectable()
export class IdBusinessV2FinanceExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fxService: IdBusinessV2FinanceFxService,
    private readonly postingService: IdBusinessV2FinancePostingService
  ) {}

  async list(query: ListExpenseQuery) {
    const pagination = getPagination(query);
    const categoryOptionId = query.categoryOptionId
      ? normalizeFinanceUuid(query.categoryOptionId, '开支分类')
      : undefined;
    const financeAccountId = query.financeAccountId
      ? normalizeFinanceUuid(query.financeAccountId, '资金账户')
      : undefined;
    const currency = query.currency ? normalizeFinanceCurrency(query.currency) : undefined;
    const occurredAt = this.parseDateRange(query.dateFrom, query.dateTo);
    const where: Prisma.IdBusinessV2FinanceExpenseWhereInput = {
      categoryOptionId,
      financeAccountId,
      currency,
      occurredAt
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2FinanceExpense.findMany({
        where,
        include: { categoryOption: true, financeAccount: true, journal: true },
        skip: pagination.skip,
        take: pagination.take,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2FinanceExpense.count({ where })
    ]);
    return {
      items: items.map((item) => ({
        id: item.id,
        journalId: item.journalId,
        categoryOptionId: item.categoryOptionId,
        categoryName: item.categoryOption.name,
        financeAccountId: item.financeAccountId,
        financeAccountName: item.financeAccount.name,
        currency: item.currency,
        amountOriginal: toV2DecimalString(item.amountOriginal),
        fxRateToCny: item.fxRateToCny.toString(),
        amountCny: toV2DecimalString(item.amountCny),
        occurredAt: item.occurredAt,
        payee: item.payee,
        receiptAttachmentId: item.receiptAttachmentId,
        remark: item.remark,
        status: item.journal.status,
        createdAt: item.createdAt
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async create(dto: CreateIdBusinessV2FinanceExpenseDto, operator?: AuthenticatedUser) {
    const categoryOptionId = normalizeFinanceUuid(dto.categoryOptionId, '开支分类');
    const financeAccountId = normalizeFinanceUuid(dto.financeAccountId, '资金账户');
    const currency = normalizeFinanceCurrency(dto.currency);
    const amount = normalizeFinanceMoney(dto.amount, '开支金额');
    const occurredAt = normalizeFinanceDate(dto.occurredAt, '发生时间');
    const manualRate =
      dto.fxRateToCny === undefined ? null : normalizeFinanceRate(dto.fxRateToCny, currency);
    const payee = normalizeFinanceText(dto.payee, '收款方', 200);
    const remark = normalizeFinanceText(dto.remark, '备注', 2000);
    const receiptAttachmentId = normalizeOptionalFinanceUuid(dto.receiptAttachmentId, '凭证');
    const idempotencyKey = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'finance_expense');

    const [category, account, rate] = await Promise.all([
      this.prisma.idBusinessV2Option.findFirst({
        where: { id: categoryOptionId, type: 'expense_category', status: 'active', deletedAt: null }
      }),
      this.prisma.idBusinessV2FinanceAccount.findUnique({ where: { id: financeAccountId } }),
      this.fxService.resolve({
        currency,
        occurredAt,
        fxRateSnapshotId: dto.fxRateSnapshotId,
        manualRate,
        manualReason: dto.manualRateReason,
        operator
      })
    ]);
    if (!category) throw new BadRequestException('开支分类不存在或已停用');
    if (!account || account.status !== 'active') {
      throw new BadRequestException('资金账户不存在或已停用');
    }
    if (account.currency !== currency)
      throw new BadRequestException('开支币种与资金账户币种不一致');
    const amountCny = roundV2Decimal(amount.mul(rate.rateToCny));

    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2FinanceExpense.findUnique({
        where: { idempotencyKey },
        include: { categoryOption: true, financeAccount: true, journal: true }
      });
      if (replay) return this.toResponse(replay);
      const expenseId = randomUUID();
      const journal = await this.postingService.post(tx, {
        journalType: 'expense',
        sourceType: 'expense',
        sourceId: expenseId,
        sourceReference: category.name,
        occurredAt,
        summary: `经营开支：${category.name}`,
        metadata: { payee, receiptAttachmentId },
        idempotencyKey: `${idempotencyKey}:journal`,
        operator,
        lines: [
          {
            accountCode: 'operating_expense',
            direction: 'debit',
            currency,
            amountOriginal: amount,
            fxRateToCny: rate.rateToCny,
            amountCny,
            fxRateSnapshotId: rate.id,
            memo: category.name
          },
          {
            accountCode: 'cash',
            direction: 'credit',
            currency,
            amountOriginal: amount,
            fxRateToCny: rate.rateToCny,
            amountCny,
            financeAccountId,
            fxRateSnapshotId: rate.id,
            memo: account.name
          }
        ]
      });
      const expense = await tx.idBusinessV2FinanceExpense.create({
        data: {
          id: expenseId,
          journalId: journal.id,
          categoryOptionId,
          financeAccountId,
          fxRateSnapshotId: rate.id,
          currency,
          amountOriginal: amount,
          fxRateToCny: rate.rateToCny,
          amountCny,
          occurredAt,
          payee,
          receiptAttachmentId,
          remark,
          idempotencyKey,
          createdByUserId: operator?.id
        },
        include: { categoryOption: true, financeAccount: true, journal: true }
      });
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance_expense.create',
          objectType: 'id_business_v2_finance_expense',
          objectId: expense.id,
          afterData: {
            categoryOptionId,
            financeAccountId,
            currency,
            amount: toV2DecimalString(amount),
            amountCny: toV2DecimalString(amountCny),
            occurredAt: occurredAt.toISOString()
          },
          remark: `记录经营开支：${category.name}`
        }
      });
      return this.toResponse(expense);
    });
  }

  private toResponse(item: {
    id: string;
    journalId: string;
    categoryOptionId: string;
    financeAccountId: string;
    currency: string;
    amountOriginal: { toString(): string };
    fxRateToCny: { toString(): string };
    amountCny: { toString(): string };
    occurredAt: Date;
    payee: string | null;
    receiptAttachmentId: string | null;
    remark: string | null;
    createdAt: Date;
    categoryOption: { name: string };
    financeAccount: { name: string };
    journal: { status: string };
  }) {
    return {
      id: item.id,
      journalId: item.journalId,
      categoryOptionId: item.categoryOptionId,
      categoryName: item.categoryOption.name,
      financeAccountId: item.financeAccountId,
      financeAccountName: item.financeAccount.name,
      currency: item.currency,
      amountOriginal: item.amountOriginal.toString(),
      fxRateToCny: item.fxRateToCny.toString(),
      amountCny: item.amountCny.toString(),
      occurredAt: item.occurredAt,
      payee: item.payee,
      receiptAttachmentId: item.receiptAttachmentId,
      remark: item.remark,
      status: item.journal.status,
      createdAt: item.createdAt
    };
  }

  private parseDateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    if (!from && !to) return undefined;
    const start = from ? normalizeFinanceDate(`${from}T00:00:00+08:00`, '开始日期') : undefined;
    const end = to ? normalizeFinanceDate(`${to}T23:59:59.999+08:00`, '结束日期') : undefined;
    return { gte: start, lte: end };
  }
}
