import type { PaginatedResult, V2PageQuery } from '@apple-business/shared';
import type { V2OrderStatus } from '@/v2/types/orders';

export type V2ActivationStoredStatus = 'active' | 'expired' | 'cancelled' | 'abnormal';

export type V2ActivationDueStatus =
  | 'active'
  | 'due_within_7_days'
  | 'due_within_23_hours'
  | 'due_within_1_hour'
  | 'expired'
  | 'cancelled'
  | 'abnormal';

export interface V2Activation {
  id: string;
  orderId: string;
  order: {
    id: string;
    orderNo: string;
    status: V2OrderStatus;
    receivedAmount: string;
    profitAmount: string | null;
  };
  customer: {
    id: string;
    name: string;
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
  account: {
    id: string;
    appleIdMasked: string;
    country: {
      id: string;
      code: string;
      name: string;
    };
  };
  maskedWebsiteAccount: string | null;
  openedAt: string;
  dueAt: string | null;
  storedStatus: V2ActivationStoredStatus;
  status: {
    code: V2ActivationDueStatus;
    label: string;
    hoursRemaining: number | null;
    daysRemaining: number | null;
  };
  remark: string | null;
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface V2ActivationListQuery extends V2PageQuery {
  keyword?: string;
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  status?: V2ActivationStoredStatus | '';
  dueStatus?: V2ActivationDueStatus | '';
  openedFrom?: string;
  openedTo?: string;
  dueFrom?: string;
  dueTo?: string;
  sortBy?: 'openedAt' | 'dueAt' | 'status' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface V2ActivationListResult extends PaginatedResult<V2Activation> {
  evaluatedAt: string;
}
