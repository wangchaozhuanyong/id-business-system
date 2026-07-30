import type { PaginatedResult, V2PageQuery } from '@apple-business/shared';
import type { V2Order } from './orders';

export type V2RenewalDueStatus =
  | 'due_within_1_hour'
  | 'due_within_23_hours'
  | 'due_within_7_days'
  | 'expired';

export type V2RenewalStatusCode = V2RenewalDueStatus | 'active';
export type V2RenewalWarningState = 'upcoming' | 'expired';

export interface V2RenewalWorkbenchItem {
  id: string;
  orderId: string;
  orderNo: string;
  customer: {
    id: string;
    name: string;
  };
  account: {
    id: string;
    appleIdMasked: string;
    currentBalance: string;
    balanceCostAmount: string;
    recordStatus: 'active' | 'disabled';
    country: {
      id: string;
      code: string;
      name: string;
    };
  };
  service: {
    id: string;
    code: string;
    name: string;
    parent: {
      id: string;
      name: string;
    } | null;
  };
  maskedWebsiteAccount: string | null;
  openedAt: string;
  dueAt: string | null;
  status: {
    code: V2RenewalStatusCode;
    label: string;
    hoursRemaining: number | null;
    daysRemaining: number | null;
  };
  warningState: V2RenewalWarningState | null;
  withinActionWindow: boolean;
  updatedAt: string;
}

export interface V2RenewalWorkbenchQuery extends V2PageQuery {
  keyword?: string;
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  dueStatus?: V2RenewalDueStatus | '';
  dueFrom?: string;
  dueTo?: string;
  warningOnly?: boolean;
  sortBy?: 'customer' | 'account' | 'currentBalance' | 'service' | 'openedAt' | 'dueAt';
  sortOrder?: 'asc' | 'desc';
}

export interface V2RenewalWorkbenchResult extends PaginatedResult<V2RenewalWorkbenchItem> {
  warningSummary: V2RenewalWarningCounts;
  evaluatedAt: string;
  revalidateAt: string | null;
}

export interface V2RenewalWarningCounts {
  warningDays: number;
  upcomingCount: number;
  expiredCount: number;
  totalCount: number;
}

export interface V2RenewalWarningSettings {
  warningDays: number;
  defaultWarningDays: number;
  minWarningDays: number;
  maxWarningDays: number;
  updatedAt: string | null;
}

export interface V2RenewalWarningSummary extends V2RenewalWarningSettings, V2RenewalWarningCounts {
  items: Array<{
    id: string;
    customer: {
      id: string;
      name: string;
    };
    account: {
      id: string;
      appleIdMasked: string;
    };
    service: {
      id: string;
      name: string;
    };
    dueAt: string | null;
    warningState: V2RenewalWarningState;
  }>;
  evaluatedAt: string;
  revalidateAt: string | null;
}

export interface V2RenewalFilterOptions {
  customers: Array<{
    id: string;
    name: string;
  }>;
  accounts: Array<{
    id: string;
    appleIdMasked: string;
  }>;
  services: Array<{
    id: string;
    code: string;
    name: string;
    parent: {
      id: string;
      name: string;
    } | null;
  }>;
}

export interface V2ManualRenewalOptions {
  settlementPlatforms: Array<{
    id: string;
    code: string;
    name: string;
    fixedFee: string;
    percentageFee: string;
  }>;
  services: Array<{
    id: string;
    code: string;
    name: string;
    category: {
      id: string;
      name: string;
    } | null;
    country: {
      id: string;
      code: string;
      name: string;
      currencyCode: string | null;
    } | null;
    businessAmount: string;
    currencyCode: string | null;
  }>;
}

export interface V2ManualRenewalPayload {
  serviceOptionId: string;
  settlementPlatformOptionId: string;
  platformOrderNo?: string | null;
  receivedAmount: string;
  balanceAmount: string;
  openedAt: string;
  dueAt: string;
  idempotencyKey: string;
  remark?: string | null;
}

export interface V2ManualRenewalResult {
  order: V2Order;
  activation: {
    id: string;
    orderId: string;
    customerId: string;
    accountId: string;
    serviceOptionId: string;
    openedAt: string;
    dueAt: string | null;
    status: string;
    createdAt: string;
  };
  ledgerEntry: {
    id: string;
    accountId: string;
    balanceAmount: string;
    costAmount: string;
    balanceBefore: string;
    balanceAfter: string;
    costBefore: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
    createdAt: string;
  };
  balance: {
    before: string;
    consumed: string;
    after: string;
    costBefore: string;
    consumedCost: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
  };
  profitAmount: string;
  idempotentReplay: boolean;
  executionBoundary: {
    manualAccountingCompleted: true;
    systemBalanceConsumed: true;
    activationCreated: true;
    externalSubscriptionActionPerformed: false;
    nextStep: 'completed';
  };
}
