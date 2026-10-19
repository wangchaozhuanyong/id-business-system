import type { Prisma } from '@prisma/client';

interface BillingAggregate {
  _sum: { amount: Prisma.Decimal | null };
  _count: { _all: number; amount: number };
}

export function onlineBillingSummary(row: BillingAggregate) {
  const count = row._count._all;
  const knownAmountCount = row._count.amount;
  const unknownAmountCount = count - knownAmountCount;
  const knownAmount = row._sum.amount?.toString() ?? null;
  const isComplete = unknownAmountCount === 0;
  return {
    amount: isComplete ? knownAmount : null,
    knownAmount,
    count,
    knownAmountCount,
    unknownAmountCount,
    isComplete
  };
}

export function onlineBillAmountMeaning(row: { status: string; amount: unknown }) {
  if (row.status !== 'success') return '结账应付金额，未确认扣款，不计入成功消费';
  return row.amount == null ? '已确认成功，扣款金额尚待核对' : '已确认成功的结账金额';
}
