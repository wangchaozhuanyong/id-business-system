import type { Amount4, Rate8 } from '../runtime/public-api';

export type IdBusinessV2FinanceCurrency = 'CNY' | 'MYR' | 'USD' | 'USDT';

export type IdBusinessV2OrderStatus =
  | 'draft'
  | 'pending'
  | 'waiting_external'
  | 'processing'
  | 'completed'
  | 'refunded'
  | 'cancelled'
  | 'failed';

export type IdBusinessV2OrderAccountDisposition = 'retained' | 'sold' | 'recovered';
export type IdBusinessV2OrderAccountSource = 'inventory' | 'customer_owned';
export type IdBusinessV2AccountLockScope = 'by_service' | 'global';
export type IdBusinessV2AccountLockStatus = 'active' | 'released' | 'expired';
export type IdBusinessV2BalanceLedgerEntryType =
  | 'gift_card_credit'
  | 'gift_card_redeemed'
  | 'gift_card_withdrawal'
  | 'order_consumption'
  | 'order_consumption_reversal'
  | 'opening_balance'
  | 'manual_adjustment'
  | 'account_loss';
export type IdBusinessV2BalanceDirection = 'credit' | 'debit' | 'adjustment';

export interface IdBusinessV2OrderRecord {
  id: string;
  orderNo: string;
  customerId: string;
  serviceOptionId: string;
  accountId: string | null;
  settlementPlatformOptionId: string | null;
  platformOrderNo: string | null;
  websiteAccountEncrypted: string | null;
  websiteAccountHash: string | null;
  websiteAccountMasked: string | null;
  websiteAccountSearchTokens: string[];
  receivedAmount: Amount4;
  receivedOriginalAmount: Amount4;
  receivedCurrency: IdBusinessV2FinanceCurrency;
  receivedFxRateToCny: Rate8;
  receivedFxSnapshotId: string | null;
  receivedFinanceAccountId: string | null;
  receivedAt: Date | null;
  platformFeeAmount: Amount4;
  accountCostAmount: Amount4;
  appliedAccountCostAmount: Amount4;
  accountSource: IdBusinessV2OrderAccountSource;
  sourceSoldOrderId: string | null;
  accountDisposition: IdBusinessV2OrderAccountDisposition;
  balanceAmount: Amount4;
  balanceCostAmount: Amount4;
  transferredBalanceCostAmount: Amount4;
  appliedBalanceCostAmount: Amount4;
  refundCostAmount: Amount4 | null;
  profitAmount: Amount4 | null;
  status: IdBusinessV2OrderStatus;
  statusChangedAt: Date;
  openedAt: Date | null;
  dueAt: Date | null;
  idempotencyKey: string;
  remark: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface IdBusinessV2AccountLockRecord {
  id: string;
  accountId: string;
  serviceOptionId: string | null;
  orderId: string;
  lockScope: IdBusinessV2AccountLockScope;
  status: IdBusinessV2AccountLockStatus;
  lockToken: string;
  reason: string | null;
  lockedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  createdByUserId: string | null;
  endedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdBusinessV2BalanceLedgerRecord {
  id: string;
  accountId: string;
  giftCardId: string | null;
  orderId: string | null;
  entryType: IdBusinessV2BalanceLedgerEntryType;
  direction: IdBusinessV2BalanceDirection;
  balanceAmount: Amount4;
  costAmount: Amount4;
  balanceBefore: Amount4;
  balanceAfter: Amount4;
  costBefore: Amount4;
  costAfter: Amount4;
  averageCostBefore: Rate8;
  averageCostAfter: Rate8;
  reversalOfEntryId: string | null;
  idempotencyKey: string;
  remark: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface IdBusinessV2OrderActivationRecord {
  id: string;
  orderId: string;
  renewedFromActivationId: string | null;
  customerId: string;
  accountId: string;
  serviceOptionId: string;
  openedAt: Date;
  dueAt: Date | null;
  status: string;
  statusChangedAt: Date;
  autoRenewalStatus: string;
  autoRenewalChangedAt: Date | null;
  remark: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdBusinessV2OrderListRecord extends IdBusinessV2OrderRecord {
  customer: { id: string; name: string };
  serviceOption: {
    id: string;
    code: string;
    name: string;
    parent: { id: string; name: string } | null;
  };
  account: {
    id: string;
    appleIdEncrypted: string;
    appleIdMasked: string;
    countryOption: { id: string; code: string; name: string };
  } | null;
  sourceSoldOrder: {
    id: string;
    orderNo: string;
    customer: { id: string; name: string };
  } | null;
  settlementPlatform: { id: string; code: string; name: string } | null;
  createdBy: { id: string; username: string; displayName: string } | null;
  locks: IdBusinessV2AccountLockRecord[];
}

export interface IdBusinessV2MatchingAccount {
  id: string;
  appleIdEncrypted: string;
  appleIdMasked: string;
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  purchaseCost: Amount4;
  ownershipTransferredAt: Date | null;
  updatedAt: Date;
  countryOption: { id: string; code: string; name: string };
  statusOption: { id: string; code: string; name: string };
  soldByOrder: {
    id: string;
    orderNo: string;
    customer: { id: string; name: string };
  } | null;
}

export interface IdBusinessV2MatchingContext {
  service: { id: string; code: string; name: string };
  category: { id: string; code: string; name: string };
  country: { id: string; code: string; name: string };
}
