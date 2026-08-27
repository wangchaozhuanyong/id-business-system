import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  isUnsupportedFinanceCurrencyEnumError,
  mapAmount4,
  mapRate8
} from '../../runtime/public-api';
import {
  mapExpense,
  mapFinanceAccount,
  mapFxSnapshot,
  mapInflow
} from './id-business-v2-finance-command.repository';

export interface FinanceExpenseFilter {
  categoryOptionId?: string;
  financeAccountId?: string;
  currency?: 'CNY' | 'MYR' | 'USD' | 'USDT';
  occurredAt?: { gte?: Date; lte?: Date };
}

export interface FinanceInflowFilter {
  nature?: 'operating_income' | 'capital_contribution' | 'borrowed_funds';
  categoryOptionId?: string;
  financeAccountId?: string;
  currency?: 'CNY' | 'MYR' | 'USD' | 'USDT';
  occurredAt?: { gte?: Date; lte?: Date };
}

export interface FinanceJournalFilter {
  journalType?: string;
  sourceType?: string;
  sourceId?: string;
  periodMonth?: string;
  businessDate?: { gte?: Date; lte?: Date };
  currency?: 'CNY' | 'MYR' | 'USD' | 'USDT';
  financeAccountId?: string;
  supplierOptionId?: string;
}

const inflowReceiptSummarySelect = {
  id: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  contentSha256: true
} satisfies Prisma.AttachmentSelect;

@Injectable()
export class IdBusinessV2FinanceQueryRepository {
  constructor(private readonly prisma: PrismaService) {}

  listFinanceAccounts(currency?: 'CNY' | 'MYR' | 'USD' | 'USDT', status?: 'active' | 'disabled') {
    return this.prisma.idBusinessV2FinanceAccount
      .findMany({
        where: { currency, status },
        orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
      .then((rows) => rows.map(mapFinanceAccount));
  }

  async listExpenses(filter: FinanceExpenseFilter, skip: number, take: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2FinanceExpense.findMany({
        where: filter,
        include: {
          categoryOption: true,
          financeAccount: true,
          journal: true,
          createdBy: { select: { id: true, username: true, displayName: true } }
        },
        skip,
        take,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2FinanceExpense.count({ where: filter })
    ]);
    return { items: items.map(mapExpense), total };
  }

  async listInflows(filter: FinanceInflowFilter, skip: number, take: number) {
    const [items, total, grouped] = await this.prisma.$transaction([
      this.prisma.idBusinessV2FinanceInflow.findMany({
        where: filter,
        include: {
          categoryOption: true,
          financeAccount: true,
          journal: true,
          receiptAttachment: { select: inflowReceiptSummarySelect },
          createdBy: { select: { id: true, username: true, displayName: true } }
        },
        skip,
        take,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2FinanceInflow.count({ where: filter }),
      this.prisma.idBusinessV2FinanceInflow.groupBy({
        by: ['nature'],
        where: { ...filter, journal: { status: 'posted' } },
        orderBy: { nature: 'asc' },
        _sum: { amountCny: true }
      })
    ]);
    return {
      items: items.map(mapInflow),
      total,
      summary: grouped.map((row) => ({
        nature: row.nature,
        amountCny: mapAmount4(row._sum?.amountCny ?? 0, 'finance_inflows.sum_amount_cny').toString()
      }))
    };
  }

  async findInflowPrerequisites(categoryOptionId: string | null, financeAccountId: string) {
    const [category, account] = await Promise.all([
      categoryOptionId
        ? this.prisma.idBusinessV2Option.findFirst({
            where: {
              id: categoryOptionId,
              type: 'income_category',
              status: 'active',
              deletedAt: null
            },
            select: { id: true, name: true }
          })
        : null,
      this.prisma.idBusinessV2FinanceAccount.findUnique({
        where: { id: financeAccountId },
        select: { id: true, name: true, currency: true, status: true }
      })
    ]);
    return { category, account };
  }

  findOrderIncomeReferenceConflict(reference: string) {
    return this.prisma.idBusinessV2Order.findFirst({
      where: {
        deletedAt: null,
        OR: [{ orderNo: reference }, { platformOrderNo: reference }]
      },
      select: { id: true, orderNo: true, platformOrderNo: true }
    });
  }

  findInflowReceipt(inflowId: string) {
    return this.prisma.idBusinessV2FinanceInflow.findUnique({
      where: { id: inflowId },
      select: {
        id: true,
        receiptAttachment: {
          select: {
            ...inflowReceiptSummarySelect,
            contentEncrypted: true
          }
        }
      }
    });
  }

  async findExpensePrerequisites(categoryOptionId: string, financeAccountId: string) {
    const [category, account] = await Promise.all([
      this.prisma.idBusinessV2Option.findFirst({
        where: {
          id: categoryOptionId,
          type: 'expense_category',
          status: 'active',
          deletedAt: null
        },
        select: { id: true, name: true }
      }),
      this.prisma.idBusinessV2FinanceAccount.findUnique({
        where: { id: financeAccountId },
        select: { id: true, name: true, currency: true, status: true }
      })
    ]);
    return { category, account };
  }

  async listJournals(filter: FinanceJournalFilter, skip: number, take: number) {
    const lineFilter: Prisma.IdBusinessV2FinanceJournalLineWhereInput = {
      currency: filter.currency,
      financeAccountId: filter.financeAccountId,
      supplierAccount: filter.supplierOptionId
        ? { is: { supplierOptionId: filter.supplierOptionId } }
        : undefined
    };
    const hasLineFilter = Boolean(
      lineFilter.currency || lineFilter.financeAccountId || lineFilter.supplierAccount
    );
    const where: Prisma.IdBusinessV2FinanceJournalWhereInput = {
      journalType: filter.journalType
        ? (filter.journalType as Prisma.EnumIdBusinessV2FinanceJournalTypeFilter)
        : undefined,
      sourceType: filter.sourceType
        ? (filter.sourceType as Prisma.EnumIdBusinessV2FinanceSourceTypeFilter)
        : undefined,
      sourceId: filter.sourceId,
      periodMonth: filter.periodMonth,
      businessDate: filter.businessDate,
      lines: hasLineFilter ? { some: lineFilter } : undefined
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2FinanceJournal.findMany({
        where,
        include: { lines: { orderBy: { lineNo: 'asc' } } },
        skip,
        take,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2FinanceJournal.count({ where })
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        lines: item.lines.map((line) => ({
          ...line,
          amountOriginal: mapAmount4(
            line.amountOriginal,
            'finance_journal_lines.amount_original'
          ).toString(),
          fxRateToCny: mapRate8(
            line.fxRateToCny,
            'finance_journal_lines.fx_rate_to_cny'
          ).toString(),
          amountCny: mapAmount4(line.amountCny, 'finance_journal_lines.amount_cny').toString()
        }))
      })),
      total
    };
  }

  listPeriods() {
    return this.prisma.idBusinessV2FinancePeriod.findMany({
      orderBy: { month: 'desc' },
      take: 120
    });
  }

  findFxSnapshotById(id: string) {
    return this.prisma.idBusinessV2FinanceFxRateSnapshot
      .findUnique({ where: { id } })
      .then((row) => (row ? mapFxSnapshot(row) : null));
  }

  findLatestFxSnapshot(currency: 'MYR' | 'USD' | 'USDT') {
    return this.prisma.idBusinessV2FinanceFxRateSnapshot
      .findFirst({ where: { currency }, orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }] })
      .then((row) => (row ? mapFxSnapshot(row) : null))
      .catch((error: unknown) => {
        if (isUnsupportedFinanceCurrencyEnumError(error, currency)) return null;
        throw error;
      });
  }

  findUsdtAutomaticSnapshot(sourceReference: string, occurredAt: Date) {
    return this.prisma.idBusinessV2FinanceFxRateSnapshot
      .findFirst({
        where: {
          currency: 'USDT',
          source: 'combined_p2p',
          sourceReference,
          expiresAt: { gt: occurredAt }
        },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]
      })
      .then((row) => (row ? mapFxSnapshot(row) : null));
  }

  findCrossAutomaticSnapshot(currency: 'MYR' | 'USD', occurredAt: Date) {
    return this.prisma.idBusinessV2FinanceFxRateSnapshot
      .findFirst({
        where: { currency, source: 'ecb_cross', expiresAt: { gt: occurredAt } },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]
      })
      .then((row) => (row ? mapFxSnapshot(row) : null));
  }
}
