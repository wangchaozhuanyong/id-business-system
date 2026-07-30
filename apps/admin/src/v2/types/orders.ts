export type V2OrderStatus =
  | 'draft'
  | 'pending'
  | 'waiting_external'
  | 'processing'
  | 'completed'
  | 'refunded'
  | 'cancelled'
  | 'failed';

export type V2OrderAccountDisposition = 'retained' | 'sold' | 'recovered';

export interface V2OrderOption {
  id: string;
  code: string;
  name: string;
}

export interface V2OrderService extends V2OrderOption {
  parent: {
    id: string;
    name: string;
  } | null;
}

export interface V2OrderAccount {
  id: string;
  appleIdMasked: string;
  country: V2OrderOption;
}

export interface V2Order {
  id: string;
  orderNo: string;
  customer: {
    id: string;
    name: string;
  };
  service: V2OrderService;
  account: V2OrderAccount | null;
  settlementPlatform: V2OrderOption | null;
  platformOrderNo: string | null;
  maskedWebsiteAccount: string | null;
  hasWebsiteAccount: boolean;
  receivedAmount: string;
  receivedOriginalAmount: string;
  receivedCurrency: V2FinanceCurrency;
  receivedFxRateToCny: string;
  receivedFxSnapshotId: string | null;
  receivedFinanceAccountId: string | null;
  receivedAt: string | null;
  platformFeeAmount: string;
  accountDisposition: V2OrderAccountDisposition;
  accountCostAmount: string;
  appliedAccountCostAmount: string;
  balanceAmount: string;
  balanceCostAmount: string;
  refundCostAmount: string | null;
  profitAmount: string | null;
  profitRate: string | null;
  status: V2OrderStatus;
  statusChangedAt: string;
  openedAt: string | null;
  dueAt: string | null;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
  activeLock: V2OrderLockSummary | null;
  operations: {
    canConsume: boolean;
    canComplete: boolean;
    canEdit: boolean;
    canEditCore: boolean;
    canEditPricing: boolean;
    canRefund: boolean;
    canCancel: boolean;
    canDelete: boolean;
  };
}

export type V2OrderListResult = PaginatedResult<V2Order>;

export interface V2OrderListQuery extends V2PageQuery {
  keyword?: string;
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  settlementPlatformOptionId?: string;
  status?: V2OrderStatus | '';
  accountDisposition?: V2OrderAccountDisposition | '';
  openedFrom?: string;
  openedTo?: string;
  sortBy?:
    | 'orderNo'
    | 'receivedAmount'
    | 'platformFeeAmount'
    | 'accountCostAmount'
    | 'balanceCostAmount'
    | 'refundCostAmount'
    | 'profitAmount'
    | 'balanceAmount'
    | 'status'
    | 'accountDisposition'
    | 'openedAt'
    | 'dueAt'
    | 'createdAt'
    | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface V2OrderEntryCustomer {
  id: string;
  name: string;
  wechat: string | null;
  maskedPhone: string | null;
}

export interface V2OrderEntryServiceOption extends V2OrderOption {
  businessAmount: string;
  currencyCode: string | null;
}

export interface V2OrderEntryCategory extends V2OrderOption {
  children: V2OrderEntryServiceOption[];
}

export interface V2OrderEntryCountry extends V2OrderOption {
  currencyCode: string | null;
  children: V2OrderEntryCategory[];
}

export interface V2OrderEntrySettlementPlatform extends V2OrderOption {
  fixedFee: string;
  percentageFee: string;
}

export interface V2OrderEntryOptions {
  customers: V2OrderEntryCustomer[];
  countries: V2OrderEntryCountry[];
  settlementPlatforms: V2OrderEntrySettlementPlatform[];
  latestFxRates: V2FinanceLatestRate[];
}

export interface V2OrderCandidate {
  id: string;
  appleIdMasked: string;
  country: V2OrderOption;
  status: V2OrderOption;
  currentBalance: string;
  balanceCostAmount: string;
  estimatedBalanceCostAmount: string;
  averageCost: string;
  purchaseCost: string;
  balanceAfterMatch: string;
  updatedAt: string;
}

export interface V2OrderMatchingResult {
  criteria: {
    service: V2OrderOption;
    category: V2OrderOption;
    country: V2OrderOption;
    requiredBalance: string;
    requiredStatusCode: 'normal';
    evaluatedAt: string;
  };
  counts: {
    activeInCountry: number;
    normalStatus: number;
    sufficientBalance: number;
    available: number;
  };
  selectedCandidateId: string | null;
  items: V2OrderCandidate[];
  revalidateAt: string | null;
}

export interface SearchV2OrderCandidatesInput {
  serviceOptionId: string;
  balanceAmount: string;
  keyword?: string;
  limit?: number;
}

export interface CreateV2OrderInput {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  settlementPlatformOptionId: string;
  platformOrderNo?: string | null;
  websiteAccount?: string | null;
  receivedAmount?: string;
  receivedOriginalAmount: string;
  receivedCurrency: V2FinanceCurrency;
  receivedFxRateToCny?: string;
  receivedFxSnapshotId?: string;
  receivedManualRateReason?: string;
  accountDisposition: Exclude<V2OrderAccountDisposition, 'recovered'>;
  balanceAmount: string;
  openedAt: string;
  dueAt: string;
  lockScope?: 'by_service' | 'global';
  idempotencyKey: string;
  remark?: string | null;
}

export interface V2OrderLockSummary {
  id: string;
  serviceOptionId: string | null;
  lockScope: 'by_service' | 'global';
  status: 'active' | 'released' | 'expired';
  lockedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  reason: string | null;
}

export interface CreateV2OrderResult {
  order: V2Order;
  lock: V2OrderLockSummary | null;
  idempotentReplay: boolean;
  nextStep: 'waiting_balance_consumption';
}

export interface ConsumeV2OrderInput {
  idempotencyKey: string;
}

export interface V2OrderConsumptionLedger {
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
}

export interface ConsumeV2OrderResult {
  order: V2Order;
  ledgerEntry: V2OrderConsumptionLedger;
  idempotentReplay: boolean;
  nextStep: 'waiting_activation_record' | 'completed' | 'refunded' | 'cancelled' | 'manual_review';
}

export interface CompleteV2OrderResult {
  order: V2Order;
  activation: {
    id: string;
    orderId: string;
    customerId: string;
    accountId: string;
    serviceOptionId: string;
    openedAt: string;
    dueAt: string | null;
    status: 'active';
    createdAt: string;
  };
  consumptionLedgerId: string;
  idempotentReplay: boolean;
}

export interface UpdateV2OrderInput {
  customerId?: string;
  serviceOptionId?: string;
  accountId?: string;
  accountDisposition?: Exclude<V2OrderAccountDisposition, 'recovered'>;
  settlementPlatformOptionId?: string | null;
  platformOrderNo?: string | null;
  websiteAccount?: string | null;
  clearWebsiteAccount?: boolean;
  receivedAmount?: string;
  receivedOriginalAmount?: string;
  balanceAmount?: string;
  openedAt?: string;
  dueAt?: string;
  lockScope?: 'by_service' | 'global';
  remark?: string | null;
  expectedUpdatedAt: string;
}

export interface RefundV2OrderInput {
  refundCostAmount: string;
  reason: string;
  restoreBalance?: boolean;
  accountReturned?: boolean;
  idempotencyKey: string;
}

export interface CancelV2OrderInput {
  reason: string;
  idempotencyKey: string;
}

export interface DeleteV2OrderInput {
  reason: string;
}

export interface V2OrderReversalLedger {
  id: string;
  accountId: string;
  entryType: 'order_consumption_reversal';
  direction: 'credit';
  balanceAmount: string;
  costAmount: string;
  balanceBefore: string;
  balanceAfter: string;
  costBefore: string;
  costAfter: string;
  averageCostBefore: string;
  averageCostAfter: string;
  reversalOfEntryId: string;
  createdAt: string;
}

export interface V2OrderLifecycleResult {
  order: V2Order;
  reversalLedger: V2OrderReversalLedger | null;
  balanceRestored: boolean;
  lockReleased: boolean;
  idempotentReplay: boolean;
}

export interface DeleteV2OrderResult {
  deleted: true;
  idempotentReplay: boolean;
}
import type {
  PaginatedResult,
  V2FinanceCurrency,
  V2FinanceLatestRate,
  V2PageQuery
} from '@apple-business/shared';
