import type { IdBusinessV2AccountLockScope } from '@prisma/client';

export interface CreateIdBusinessV2OrderDto {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
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
