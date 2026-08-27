import type { IdBusinessV2ActivationStatus } from '@prisma/client';
import type { Amount4 } from '../runtime/public-api';

export type ActivationSortField = 'openedAt' | 'dueAt' | 'status' | 'createdAt' | 'updatedAt';
export type ActivationSortDirection = 'asc' | 'desc';

export interface ActivationDateRange {
  gte?: Date;
  lte?: Date;
}

export interface ActivationListCriteria {
  keyword: string | null;
  customerId: string | null;
  serviceOptionId: string | null;
  accountId: string | null;
  status: IdBusinessV2ActivationStatus | null;
  dueFilter:
    | import('./id-business-v2-activation-status.service').IdBusinessV2ActivationDueStatusFilter
    | null;
  openedAt?: ActivationDateRange;
  dueAt?: ActivationDateRange;
  sortField: ActivationSortField;
  sortDirection: ActivationSortDirection;
  skip: number;
  take: number;
  evaluatedAt: Date;
}

export interface ActivationRecord {
  id: string;
  orderId: string;
  openedAt: Date;
  dueAt: Date | null;
  status: IdBusinessV2ActivationStatus;
  remark: string | null;
  statusChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  hasActiveUpgradeBalanceReturn: boolean;
  order: {
    id: string;
    orderNo: string;
    status: string;
    websiteAccountMasked: string | null;
    websiteAccountEncrypted: string | null;
    receivedAmount: Amount4;
    profitAmount: Amount4 | null;
  };
  customer: { id: string; name: string };
  account: {
    id: string;
    appleIdEncrypted: string;
    appleIdMasked: string;
    countryOption: { id: string; code: string; name: string };
  };
  serviceOption: {
    id: string;
    code: string;
    name: string;
    parent: { id: string; name: string } | null;
  };
  renewedBy: {
    id: string;
    serviceOptionId: string;
  } | null;
  createdBy: { id: string; username: string; displayName: string } | null;
}
