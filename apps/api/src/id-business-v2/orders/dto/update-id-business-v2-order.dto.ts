import type {
  IdBusinessV2AccountLockScope,
  IdBusinessV2OrderAccountDisposition
} from '@prisma/client';

export interface UpdateIdBusinessV2OrderDto {
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  accountDisposition?: IdBusinessV2OrderAccountDisposition | string;
  settlementPlatformOptionId?: string | null;
  platformOrderNo?: string | null;
  websiteAccount?: string | null;
  clearWebsiteAccount?: boolean;
  receivedAmount?: string | number;
  balanceAmount?: string | number;
  openedAt?: string;
  dueAt?: string;
  lockScope?: IdBusinessV2AccountLockScope | string;
  remark?: string | null;
  expectedUpdatedAt: string;
}
