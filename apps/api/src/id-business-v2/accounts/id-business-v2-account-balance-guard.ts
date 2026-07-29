import { ConflictException } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';

export interface LockedAccountBalanceRow {
  id: string;
  currentBalance: PrismaNamespace.Decimal;
  balanceCostAmount: PrismaNamespace.Decimal;
  soldByOrderId: string | null;
  lossReportedAt: Date | null;
}

export function assertAccountLossNotReported(lossReportedAt: Date | null, message: string) {
  if (lossReportedAt) throw new ConflictException(message);
}
