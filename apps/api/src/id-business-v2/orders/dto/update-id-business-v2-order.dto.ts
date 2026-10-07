import type {
  IdBusinessV2AccountLockScope,
  IdBusinessV2OrderAccountDisposition,
  IdBusinessV2OrderAccountSource
} from '@prisma/client';
import type { V2OrderReceiptCurrency } from '@apple-business/shared';

export interface UpdateIdBusinessV2OrderDto {
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  accountSource?: IdBusinessV2OrderAccountSource | string;
  accountDisposition?: IdBusinessV2OrderAccountDisposition | string;
  settlementPlatformOptionId?: string | null;
  platformOrderNo?: string | null;
  websiteAccount?: string | null;
  clearWebsiteAccount?: boolean;
  receivedAmount?: string | number;
  receivedOriginalAmount?: string | number;
  receivedCurrency?: V2OrderReceiptCurrency;
  receivedFinanceAccountId?: string | null;
  receivedFxRateToCny?: string | number;
  receivedFxSnapshotId?: string | null;
  receivedManualRateReason?: string | null;
  balanceAmount?: string | number;
  openedAt?: string;
  dueAt?: string;
  lockScope?: IdBusinessV2AccountLockScope | string;
  remark?: string | null;
  expectedUpdatedAt: string;
}
