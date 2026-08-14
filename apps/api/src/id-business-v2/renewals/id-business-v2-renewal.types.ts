import type { Amount4, Rate8 } from '../runtime/public-api';

export type IdBusinessV2ActivationStatus = 'active' | 'expired' | 'cancelled' | 'abnormal';
export type IdBusinessV2RenewalDueStatus =
  | 'due_within_1_hour'
  | 'due_within_23_hours'
  | 'due_within_7_days'
  | 'expired';

export interface RenewalBaseCriteria {
  keyword?: string | null;
  customerId?: string | null;
  serviceOptionId?: string | null;
  accountId?: string | null;
  requireAvailableAccount?: boolean;
}

export type RenewalDueFilter =
  | { kind: 'due_status'; status: IdBusinessV2RenewalDueStatus; evaluatedAt: Date }
  | {
      kind: 'date_range';
      dueAt: { gte?: Date; lte?: Date };
      base?: Exclude<RenewalDueFilter, { kind: 'date_range' }>;
    }
  | { kind: 'warning'; evaluatedAt: Date; warningDays: number }
  | { kind: 'default'; evaluatedAt: Date; warningDays: number }
  | { kind: 'all_due' };

export interface RenewalRecord {
  id: string;
  orderId: string;
  openedAt: Date;
  dueAt: Date | null;
  status: IdBusinessV2ActivationStatus;
  updatedAt: Date;
  order: {
    id: string;
    orderNo: string;
    websiteAccountEncrypted: string | null;
    websiteAccountMasked: string | null;
  };
  customer: { id: string; name: string };
  account: {
    id: string;
    appleIdEncrypted: string;
    appleIdMasked: string;
    currentBalance: Amount4;
    balanceCostAmount: Amount4;
    recordStatus: string;
    soldByOrderId: string | null;
    soldByOrder: {
      id: string;
      orderNo: string;
      customer: { id: string; name: string };
    } | null;
    countryOption: { id: string; code: string; name: string };
  };
  serviceOption: {
    id: string;
    code: string;
    name: string;
    parent: { id: string; name: string } | null;
  };
}

export interface ManualRenewalReplayOrder {
  id: string;
  customerId: string;
  serviceOptionId: string;
  accountId: string | null;
  settlementPlatformOptionId: string | null;
  platformOrderNo: string | null;
  receivedAmount: Amount4;
  balanceAmount: Amount4;
  balanceCostAmount: Amount4;
  profitAmount: Amount4 | null;
  openedAt: Date | null;
  dueAt: Date | null;
  remark: string | null;
  status: string;
  deletedAt: Date | null;
  activation: ManualRenewalActivationRecord | null;
  balanceLedger: ManualRenewalLedgerRecord[];
}

export interface ManualRenewalActivationRecord {
  id: string;
  orderId: string;
  customerId: string;
  accountId: string;
  serviceOptionId: string;
  openedAt: Date;
  dueAt: Date | null;
  status: string;
  createdAt: Date;
}

export interface ManualRenewalLedgerRecord {
  id: string;
  accountId: string;
  orderId: string | null;
  entryType: string;
  direction: string;
  balanceAmount: Amount4;
  costAmount: Amount4;
  balanceBefore: Amount4;
  balanceAfter: Amount4;
  costBefore: Amount4;
  costAfter: Amount4;
  averageCostBefore: Rate8;
  averageCostAfter: Rate8;
  createdAt: Date;
}
