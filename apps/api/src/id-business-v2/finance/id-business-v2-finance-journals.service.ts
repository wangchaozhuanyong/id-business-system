import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';
import {
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceIdempotencyKey,
  normalizeFinanceText,
  normalizeFinanceUuid
} from './id-business-v2-finance-input';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';

interface ListJournalsQuery extends PaginationQuery {
  journalType?: string;
  sourceType?: string;
  sourceId?: string;
  periodMonth?: string;
  dateFrom?: string;
  dateTo?: string;
  currency?: string;
  supplierOptionId?: string;
  financeAccountId?: string;
}

@Injectable()
export class IdBusinessV2FinanceJournalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postingService: IdBusinessV2FinancePostingService
  ) {}

  async list(query: ListJournalsQuery) {
    const pagination = getPagination(query);
    const lineFilter: Prisma.IdBusinessV2FinanceJournalLineWhereInput = {
      currency: query.currency ? normalizeFinanceCurrency(query.currency) : undefined,
      financeAccountId: query.financeAccountId
        ? normalizeFinanceUuid(query.financeAccountId, '资金账户')
        : undefined,
      supplierAccount: query.supplierOptionId
        ? {
            is: {
              supplierOptionId: normalizeFinanceUuid(query.supplierOptionId, '供应商')
            }
          }
        : undefined
    };
    const hasLineFilter = Boolean(
      lineFilter.currency || lineFilter.financeAccountId || lineFilter.supplierAccount
    );
    const where: Prisma.IdBusinessV2FinanceJournalWhereInput = {
      journalType: query.journalType
        ? (query.journalType as Prisma.EnumIdBusinessV2FinanceJournalTypeFilter)
        : undefined,
      sourceType: query.sourceType
        ? (query.sourceType as Prisma.EnumIdBusinessV2FinanceSourceTypeFilter)
        : undefined,
      sourceId: query.sourceId || undefined,
      periodMonth: query.periodMonth || undefined,
      businessDate:
        query.dateFrom || query.dateTo
          ? {
              gte: query.dateFrom
                ? normalizeFinanceDate(`${query.dateFrom}T00:00:00.000Z`, '开始日期')
                : undefined,
              lte: query.dateTo
                ? normalizeFinanceDate(`${query.dateTo}T00:00:00.000Z`, '结束日期')
                : undefined
            }
          : undefined,
      lines: hasLineFilter ? { some: lineFilter } : undefined
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2FinanceJournal.findMany({
        where,
        include: { lines: { orderBy: { lineNo: 'asc' } } },
        skip: pagination.skip,
        take: pagination.take,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2FinanceJournal.count({ where })
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        lines: item.lines.map((line) => ({
          ...line,
          amountOriginal: toV2DecimalString(line.amountOriginal),
          fxRateToCny: line.fxRateToCny.toString(),
          amountCny: toV2DecimalString(line.amountCny)
        }))
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  reverse(
    journalId: string,
    reasonValue: string,
    idempotencyKeyValue: string,
    operator?: AuthenticatedUser
  ) {
    const reason = normalizeFinanceText(reasonValue, '冲销原因', 500, true)!;
    const idempotencyKey = normalizeFinanceIdempotencyKey(idempotencyKeyValue, 'finance_reversal');
    return this.prisma.$transaction(async (tx) => {
      const reversal = await this.postingService.reverse(
        tx,
        journalId,
        reason,
        idempotencyKey,
        operator
      );
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance_journal.reverse',
          objectType: 'id_business_v2_finance_journal',
          objectId: journalId,
          afterData: { reversalJournalId: reversal.id, reason },
          remark: `冲销财务日记：${reversal.sourceReference ?? journalId}`
        }
      });
      return reversal;
    });
  }
}
