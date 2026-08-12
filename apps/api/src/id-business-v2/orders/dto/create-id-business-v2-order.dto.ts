import type {
  IdBusinessV2AccountLockScope,
  IdBusinessV2FinanceCurrency,
  IdBusinessV2OrderAccountDisposition,
  IdBusinessV2OrderAccountSource
} from '@prisma/client';

export interface CreateIdBusinessV2OrderDto {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  accountSource?: IdBusinessV2OrderAccountSource | string;
  accountDisposition: IdBusinessV2OrderAccountDisposition | string;
  settlementPlatformOptionId: string;
  platformOrderNo?: string | null;
  websiteAccount?: string | null;
  receivedAmount?: string | number;
  receivedOriginalAmount?: string | number;
  receivedCurrency?: IdBusinessV2FinanceCurrency;
  receivedFxRateToCny?: string | number;
  receivedFxSnapshotId?: string | null;
  receivedManualRateReason?: string | null;
  balanceAmount: string | number;
  openedAt: string;
  dueAt: string;
  lockScope?: IdBusinessV2AccountLockScope | string;
  idempotencyKey: string;
  remark?: string | null;
}
