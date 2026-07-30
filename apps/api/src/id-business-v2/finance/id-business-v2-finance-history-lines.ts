import type { Prisma } from '@prisma/client';
import type { FinancePostingLineInput } from './id-business-v2-finance-posting.service';

export function createHistoricalCnyPair(
  debitCode: FinancePostingLineInput['accountCode'],
  debitDirection: FinancePostingLineInput['direction'],
  creditCode: FinancePostingLineInput['accountCode'],
  creditDirection: FinancePostingLineInput['direction'],
  amount: Prisma.Decimal,
  rateSnapshotId: string,
  memo: string
) {
  return [
    createHistoricalCnyLine(debitCode, debitDirection, amount, rateSnapshotId, memo),
    createHistoricalCnyLine(creditCode, creditDirection, amount, rateSnapshotId, memo)
  ];
}

export function pushHistoricalCnyPair(
  lines: FinancePostingLineInput[],
  debitCode: FinancePostingLineInput['accountCode'],
  debitDirection: FinancePostingLineInput['direction'],
  creditCode: FinancePostingLineInput['accountCode'],
  creditDirection: FinancePostingLineInput['direction'],
  amount: Prisma.Decimal,
  rateSnapshotId: string,
  memo: string
) {
  if (amount.lte(0)) return;
  lines.push(
    createHistoricalCnyLine(debitCode, debitDirection, amount, rateSnapshotId, memo),
    createHistoricalCnyLine(creditCode, creditDirection, amount, rateSnapshotId, memo)
  );
}

export function createHistoricalCnyLine(
  accountCode: FinancePostingLineInput['accountCode'],
  direction: FinancePostingLineInput['direction'],
  amount: Prisma.Decimal,
  rateSnapshotId: string,
  memo: string
): FinancePostingLineInput {
  return {
    accountCode,
    direction,
    currency: 'CNY',
    amountOriginal: amount,
    fxRateToCny: 1,
    amountCny: amount,
    fxRateSnapshotId: rateSnapshotId,
    memo
  };
}
