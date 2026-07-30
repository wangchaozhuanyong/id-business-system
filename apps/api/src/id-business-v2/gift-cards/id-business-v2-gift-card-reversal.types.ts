import type { Prisma } from '@prisma/client';

export interface LockedGiftCardReversalAccountRow {
  id: string;
  appleIdMasked: string;
  currentBalance: Prisma.Decimal;
  balanceCostAmount: Prisma.Decimal;
  recordStatus: string;
  lossReportedAt: Date | null;
}

export interface LockedGiftCardReversalRow {
  id: string;
  accountId: string;
  supplierOptionId: string | null;
  sourceAttachmentId: string | null;
  codeMasked: string;
  codeTail: string;
  faceValue: Prisma.Decimal;
  exchangeRate: Prisma.Decimal;
  costAmount: Prisma.Decimal;
  status: string;
  createdAt: Date;
}
