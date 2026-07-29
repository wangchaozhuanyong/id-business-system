import type {
  IdBusinessV2AccountLockScope,
  IdBusinessV2OrderAccountDisposition
} from '@prisma/client';

export interface CreateIdBusinessV2OrderDto {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  accountDisposition: IdBusinessV2OrderAccountDisposition | string;
  settlementPlatformOptionId?: string | null;
  platformOrderNo?: string | null;
  websiteAccount?: string | null;
  receivedAmount: string | number;
  balanceAmount: string | number;
  openedAt: string;
  dueAt: string;
  lockScope?: IdBusinessV2AccountLockScope | string;
  idempotencyKey: string;
  remark?: string | null;
}
