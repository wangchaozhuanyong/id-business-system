import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { mapAmount4, mapRate8 } from '../../runtime/public-api';

type Transaction = V2CommandTransaction;

const inflowInclude = {
  categoryOption: true,
  financeAccount: true,
  journal: true,
  receiptAttachment: {
    select: { id: true, originalName: true, mimeType: true, sizeBytes: true, contentSha256: true }
  }
} satisfies Prisma.IdBusinessV2FinanceInflowInclude;

@Injectable()
export class IdBusinessV2FinanceCommandRepository {
  findJournalReplay(tx: Transaction, idempotencyKey: string) {
    return tx.idBusinessV2FinanceJournal
      .findUnique({
        where: { idempotencyKey },
        include: { lines: { orderBy: { lineNo: 'asc' } } }
      })
      .then((row) => (row ? mapJournal(row) : null));
  }

  findJournalForReversal(tx: Transaction, id: string) {
    return tx.idBusinessV2FinanceJournal
      .findUnique({
        where: { id },
        include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true }
      })
      .then((row) => (row ? mapJournal(row) : null));
  }

  createJournal(tx: Transaction, data: Prisma.IdBusinessV2FinanceJournalUncheckedCreateInput) {
    return tx.idBusinessV2FinanceJournal
      .create({
        data,
        include: { lines: { orderBy: { lineNo: 'asc' } } }
      })
      .then(mapJournal);
  }

  claimJournalReversal(tx: Transaction, id: string, reversedAt: Date) {
    return tx.idBusinessV2FinanceJournal.updateMany({
      where: { id, status: 'posted' },
      data: { status: 'reversed', reversedAt }
    });
  }

  findJournalWithLinesOrThrow(tx: Transaction, id: string) {
    return tx.idBusinessV2FinanceJournal
      .findUniqueOrThrow({
        where: { id },
        include: { lines: { orderBy: { lineNo: 'asc' } } }
      })
      .then(mapJournal);
  }

  incrementFinanceAccount(
    tx: Transaction,
    id: string,
    currentBalance: string,
    currentBalanceCny: string
  ) {
    return tx.idBusinessV2FinanceAccount.update({
      where: { id },
      data: {
        currentBalance: { increment: currentBalance },
        currentBalanceCny: { increment: currentBalanceCny }
      }
    });
  }

  findOpeningAccountReplay(tx: Transaction, idempotencyKey: string) {
    return tx.idBusinessV2FinanceJournal.findUnique({
      where: { idempotencyKey },
      select: { id: true }
    });
  }

  findAccountForOpeningJournal(tx: Transaction, journalId: string) {
    return tx.idBusinessV2FinanceAccount
      .findFirst({
        where: { journalLines: { some: { journalId, accountCode: 'cash' } } }
      })
      .then((row) => (row ? mapFinanceAccount(row) : null));
  }

  createFinanceAccount(
    tx: Transaction,
    data: Prisma.IdBusinessV2FinanceAccountUncheckedCreateInput
  ) {
    return tx.idBusinessV2FinanceAccount.create({ data }).then(mapFinanceAccount);
  }

  findFinanceAccount(tx: Transaction, id: string) {
    return tx.idBusinessV2FinanceAccount
      .findUnique({ where: { id } })
      .then((row) => (row ? mapFinanceAccount(row) : null));
  }

  findFinanceAccountOrThrow(tx: Transaction, id: string) {
    return tx.idBusinessV2FinanceAccount
      .findUniqueOrThrow({ where: { id } })
      .then(mapFinanceAccount);
  }

  updateFinanceAccount(
    tx: Transaction,
    id: string,
    expectedUpdatedAt: Date,
    data: Prisma.IdBusinessV2FinanceAccountUncheckedUpdateInput
  ) {
    return tx.idBusinessV2FinanceAccount
      .update({ where: { id, updatedAt: expectedUpdatedAt }, data })
      .then(mapFinanceAccount);
  }

  findExpenseReplay(tx: Transaction, idempotencyKey: string) {
    return tx.idBusinessV2FinanceExpense
      .findUnique({
        where: { idempotencyKey },
        include: { categoryOption: true, financeAccount: true, journal: true }
      })
      .then((row) => (row ? mapExpense(row) : null));
  }

  findExpenseForCorrection(tx: Transaction, id: string) {
    return tx.idBusinessV2FinanceExpense
      .findUnique({
        where: { id },
        include: { categoryOption: true, financeAccount: true, journal: true }
      })
      .then((row) => (row ? mapExpense(row) : null));
  }

  createExpense(tx: Transaction, data: Prisma.IdBusinessV2FinanceExpenseUncheckedCreateInput) {
    return tx.idBusinessV2FinanceExpense
      .create({
        data,
        include: { categoryOption: true, financeAccount: true, journal: true }
      })
      .then(mapExpense);
  }

  findInflowReplay(tx: Transaction, idempotencyKey: string) {
    return tx.idBusinessV2FinanceInflow
      .findUnique({
        where: { idempotencyKey },
        include: inflowInclude
      })
      .then((row) => (row ? mapInflow(row) : null));
  }

  findInflowForCorrection(tx: Transaction, id: string) {
    return tx.idBusinessV2FinanceInflow
      .findUnique({
        where: { id },
        include: inflowInclude
      })
      .then((row) => (row ? mapInflow(row) : null));
  }

  createInflow(tx: Transaction, data: Prisma.IdBusinessV2FinanceInflowUncheckedCreateInput) {
    return tx.idBusinessV2FinanceInflow
      .create({
        data,
        include: inflowInclude
      })
      .then(mapInflow);
  }

  findIncomeReference(tx: Transaction, normalizedReference: string) {
    return tx.idBusinessV2FinanceIncomeReference.findUnique({
      where: { normalizedReference }
    });
  }

  createInflowIncomeReference(tx: Transaction, normalizedReference: string, firstInflowId: string) {
    return tx.idBusinessV2FinanceIncomeReference.create({
      data: { normalizedReference, sourceType: 'inflow', firstInflowId }
    });
  }

  createOrderIncomeReference(tx: Transaction, normalizedReference: string, orderId: string) {
    return tx.idBusinessV2FinanceIncomeReference.create({
      data: { normalizedReference, sourceType: 'order', orderId }
    });
  }

  createAttachment(tx: Transaction, data: Prisma.AttachmentUncheckedCreateInput) {
    return tx.attachment.create({ data, select: { id: true } });
  }

  createFxSnapshot(
    tx: Transaction,
    data: Prisma.IdBusinessV2FinanceFxRateSnapshotUncheckedCreateInput
  ) {
    return tx.idBusinessV2FinanceFxRateSnapshot.create({ data }).then(mapFxSnapshot);
  }

  findPeriod(tx: Transaction, month: string) {
    return tx.idBusinessV2FinancePeriod.findUnique({ where: { month } });
  }

  closePeriod(tx: Transaction, month: string, now: Date, userId?: string) {
    return tx.idBusinessV2FinancePeriod.upsert({
      where: { month },
      update: {
        status: 'closed',
        closedAt: now,
        closedByUserId: userId,
        reopenReason: null,
        reopenedAt: null,
        reopenedByUserId: null
      },
      create: { month, status: 'closed', closedAt: now, closedByUserId: userId }
    });
  }

  reopenPeriod(tx: Transaction, month: string, reason: string, now: Date, userId?: string) {
    return tx.idBusinessV2FinancePeriod.update({
      where: { month },
      data: {
        status: 'reopened',
        reopenReason: reason,
        reopenedAt: now,
        reopenedByUserId: userId
      }
    });
  }
}

export function mapFinanceAccount<
  T extends {
    openingBalance: unknown;
    currentBalance: unknown;
    openingBalanceCny: unknown;
    currentBalanceCny: unknown;
  }
>(row: T) {
  return {
    ...row,
    openingBalance: mapAmount4(row.openingBalance, 'finance_accounts.opening_balance').toString(),
    currentBalance: mapAmount4(row.currentBalance, 'finance_accounts.current_balance').toString(),
    openingBalanceCny: mapAmount4(
      row.openingBalanceCny,
      'finance_accounts.opening_balance_cny'
    ).toString(),
    currentBalanceCny: mapAmount4(
      row.currentBalanceCny,
      'finance_accounts.current_balance_cny'
    ).toString()
  };
}

export function mapExpense<
  T extends { amountOriginal: unknown; fxRateToCny: unknown; amountCny: unknown }
>(row: T) {
  return {
    ...row,
    amountOriginal: mapAmount4(row.amountOriginal, 'finance_expenses.amount_original').toString(),
    fxRateToCny: mapRate8(row.fxRateToCny, 'finance_expenses.fx_rate_to_cny').toString(),
    amountCny: mapAmount4(row.amountCny, 'finance_expenses.amount_cny').toString()
  };
}

export function mapInflow<
  T extends { amountOriginal: unknown; fxRateToCny: unknown; amountCny: unknown }
>(row: T) {
  return {
    ...row,
    amountOriginal: mapAmount4(row.amountOriginal, 'finance_inflows.amount_original').toString(),
    fxRateToCny: mapRate8(row.fxRateToCny, 'finance_inflows.fx_rate_to_cny').toString(),
    amountCny: mapAmount4(row.amountCny, 'finance_inflows.amount_cny').toString()
  };
}

export function mapFxSnapshot<T extends { rateToCny: unknown }>(row: T) {
  return {
    ...row,
    rateToCny: mapRate8(
      row.rateToCny,
      'id_business_v2_finance_fx_rate_snapshots.rate_to_cny'
    ).toString()
  };
}

export function mapJournal<
  T extends {
    lines: Array<{ amountOriginal: unknown; fxRateToCny: unknown; amountCny: unknown }>;
  }
>(
  row: T
): Omit<T, 'lines'> & {
  lines: Array<
    Omit<T['lines'][number], 'amountOriginal' | 'fxRateToCny' | 'amountCny'> & {
      amountOriginal: string;
      fxRateToCny: string;
      amountCny: string;
    }
  >;
} {
  const { lines, ...journal } = row;
  return {
    ...journal,
    lines: lines.map(mapJournalLine)
  };
}

function mapJournalLine<
  T extends { amountOriginal: unknown; fxRateToCny: unknown; amountCny: unknown }
>(
  line: T
): Omit<T, 'amountOriginal' | 'fxRateToCny' | 'amountCny'> & {
  amountOriginal: string;
  fxRateToCny: string;
  amountCny: string;
} {
  return {
    ...line,
    amountOriginal: mapAmount4(
      line.amountOriginal,
      'finance_journal_lines.amount_original'
    ).toString(),
    fxRateToCny: mapRate8(line.fxRateToCny, 'finance_journal_lines.fx_rate_to_cny').toString(),
    amountCny: mapAmount4(line.amountCny, 'finance_journal_lines.amount_cny').toString()
  };
}
