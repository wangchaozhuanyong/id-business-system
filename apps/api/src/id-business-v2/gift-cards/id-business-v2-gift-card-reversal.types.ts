import type { Amount4, Rate8 } from '../runtime/public-api';

export interface LockedGiftCardReversalAccountRow {
  id: string;
  appleIdMasked: string;
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
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
  faceValue: Amount4;
  exchangeRate: Rate8;
  costAmount: Amount4;
  status: string;
  createdAt: Date;
}
