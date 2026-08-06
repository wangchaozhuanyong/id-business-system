import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import {
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
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
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';

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
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly commandRepository: IdBusinessV2FinanceCommandRepository,
    private readonly queryRepository: IdBusinessV2FinanceQueryRepository,
    private readonly audit: V2TransactionalAuditService,
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
    const where = {
      categoryOptionId,
      financeAccountId,
      currency,
      occurredAt
    };
    const { items, total } = await this.queryRepository.listExpenses(
      where,
      pagination.skip,
      pagination.take
    );
    return {
      items: items.map((item) => ({
        id: item.id,
        journalId: item.journalId,
        categoryOptionId: item.categoryOptionId,
        categoryName: item.categoryOption.name,
        financeAccountId: item.financeAccountId,
        financeAccountName: item.financeAccount.name,
        currency: item.currency,
        amountOriginal: item.amountOriginal,
        fxRateToCny: item.fxRateToCny,
        amountCny: item.amountCny,
        occurredAt: item.occurredAt,
        payee: item.payee,
        receiptAttachmentId: item.receiptAttachmentId,
        remark: item.remark,
        status: item.journal.status,
        createdBy: item.createdBy,
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

    const [{ category, account }, rate] = await Promise.all([
      this.queryRepository.findExpensePrerequisites(categoryOptionId, financeAccountId),
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
    const rateToCny = Rate8.from(rate.rateToCny);
    const amountCny = rateToCny.apply(amount);

    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.commandRepository.findExpenseReplay(tx, idempotencyKey);
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
            fxRateToCny: rateToCny,
            amountCny,
            fxRateSnapshotId: rate.id,
            memo: category.name
          },
          {
            accountCode: 'cash',
            direction: 'credit',
            currency,
            amountOriginal: amount,
            fxRateToCny: rateToCny,
            amountCny,
            financeAccountId,
            fxRateSnapshotId: rate.id,
            memo: account.name
          }
        ]
      });
      const expense = await this.commandRepository.createExpense(tx, {
        id: expenseId,
        journalId: journal.id,
        categoryOptionId,
        financeAccountId,
        fxRateSnapshotId: rate.id,
        currency,
        amountOriginal: amount.toString(),
        fxRateToCny: rateToCny.toString(),
        amountCny: amountCny.toString(),
        occurredAt,
        payee,
        receiptAttachmentId,
        remark,
        idempotencyKey,
        createdByUserId: operator?.id
      });
      await this.audit.append(tx, {
        userId: operator?.id,
        module: 'id_business_v2_finance',
        action: 'id_business_v2.finance_expense.create',
        objectType: 'id_business_v2_finance_expense',
        objectId: expense.id,
        afterData: {
          categoryOptionId,
          financeAccountId,
          currency,
          amount: amount.toString(),
          amountCny: amountCny.toString(),
          occurredAt: occurredAt.toISOString()
        },
        remark: `记录经营开支：${category.name}`
      });
      return this.toResponse(expense);
    }, this.commandOptions(operator));
  }

  private toResponse(item: {
    id: string;
    journalId: string;
    categoryOptionId: string;
    financeAccountId: string;
    currency: string;
    amountOriginal: string;
    fxRateToCny: string;
    amountCny: string;
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
      amountOriginal: item.amountOriginal,
      fxRateToCny: item.fxRateToCny,
      amountCny: item.amountCny,
      occurredAt: item.occurredAt,
      payee: item.payee,
      receiptAttachmentId: item.receiptAttachmentId,
      remark: item.remark,
      status: item.journal.status,
      createdAt: item.createdAt
    };
  }

  private parseDateRange(from?: string, to?: string) {
    if (!from && !to) return undefined;
    const start = from ? normalizeFinanceDate(`${from}T00:00:00+08:00`, '开始日期') : undefined;
    const end = to ? normalizeFinanceDate(`${to}T23:59:59.999+08:00`, '结束日期') : undefined;
    return { gte: start, lte: end };
  }

  private commandOptions(operator?: AuthenticatedUser) {
    return { requestId: randomUUID(), operator } as const;
  }
}
