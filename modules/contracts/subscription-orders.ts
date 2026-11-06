import type { DecimalString, PaginatedResult, PaginationQueryContract } from './common.ts';
import type { V2InventoryActor } from './inventory.ts';

export const V2_GPT_BANK_ORDER_PLANS = ['go', 'plus', 'pro_5x', 'pro_20x', 'pro_50x'] as const;
export type V2GptBankOrderPlan = (typeof V2_GPT_BANK_ORDER_PLANS)[number];

export const V2_SUBSCRIPTION_ORDER_CURRENCIES = ['CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP'] as const;
export type V2SubscriptionOrderCurrency = (typeof V2_SUBSCRIPTION_ORDER_CURRENCIES)[number];
export type V2SubscriptionOrderSaleCurrency = 'CNY' | 'MYR';

type V2GptBankOrderCustomerAccount = {
  businessType: 'renewal';
  email: string;
  stockId?: never;
  stockVersion?: never;
};

type V2GptBankOrderStockAccount = {
  businessType: 'finished_delivery';
  email?: never;
  stockId: string;
  stockVersion: number;
};

type V2GptBankOrderStandardCost = {
  costBasis?: 'standard';
  feeRuleVersion?: number;
  includeCardOpeningFee?: boolean;
  emailCostAmount?: DecimalString;
  emailCostCurrency?: V2SubscriptionOrderCurrency;
  actualCostAmount?: never;
  actualCostCurrency?: never;
};

type V2GptBankOrderActualCost = {
  costBasis: 'actual';
  feeRuleVersion?: never;
  includeCardOpeningFee?: false;
  emailCostAmount?: never;
  emailCostCurrency?: never;
  actualCostAmount: DecimalString;
  actualCostCurrency: V2SubscriptionOrderCurrency;
};

type V2GptOrderFields = {
  plan: V2GptBankOrderPlan;
  customerId: string;
  telegram?: string;
  paidAmount: DecimalString;
  saleAmount: DecimalString;
  paidConfirmed: boolean;
  receiptConfirmed: boolean;
  costConfirmed: boolean;
  openedAt: string;
  dueAt?: string;
  remark?: string;
  idempotencyKey: string;
} & (V2GptBankOrderCustomerAccount | V2GptBankOrderStockAccount);

export type V2GptBankOrderInput = V2GptOrderFields & {
  cardId: string;
  paidCurrency: V2SubscriptionOrderCurrency;
  saleCurrency: V2SubscriptionOrderSaleCurrency;
} & (V2GptBankOrderStandardCost | V2GptBankOrderActualCost);

export type V2GptApplePurchaseInput = V2GptOrderFields & {
  paymentMethod: 'apple_in_app';
  appleAccountId: string;
  expectedAppleUpdatedAt: string;
  paidCurrency: 'USD';
  saleCurrency: V2SubscriptionOrderSaleCurrency | 'USD';
};

export interface V2GptOrderStockOption {
  stockId: string;
  stockVersion: number;
  email: string;
}

export interface V2GptOrderCardOption {
  id: string;
  last6: string;
  label: string;
}

export interface V2GptOrderCustomerOption {
  id: string;
  name: string;
  contactLabel?: string;
}

export interface V2GptBankOrderListQuery extends PaginationQueryContract {
  keyword?: string;
  customerId?: string;
}

export interface V2GptBankOrderCustomerSnapshot {
  name: string;
  phone: string | null;
  wechat: string | null;
  qq: string | null;
  whatsapp: string | null;
  telegram: string | null;
}

export interface V2GptBankOrderRecord {
  id: string;
  orderNo: string;
  plan: V2GptBankOrderPlan;
  businessType: V2GptBankOrderInput['businessType'];
  customerId: string;
  customer: V2GptBankOrderCustomerSnapshot;
  email: string;
  stockId: string | null;
  paymentMethod: 'bank_card' | 'apple_in_app';
  cancelledAt?: string | null;
  cardId: string | null;
  cardLast6: string | null;
  appleAccountId: string | null;
  appleAccount: string | null;
  paidAmount: DecimalString;
  paidCurrency: V2SubscriptionOrderCurrency;
  saleAmount: DecimalString;
  saleCurrency: V2SubscriptionOrderSaleCurrency | 'USD';
  openedAt: string;
  dueAt: string;
  paidConfirmed: boolean;
  receiptConfirmed: boolean;
  costConfirmed: boolean;
  effectiveCostCny: DecimalString | null;
  effectiveCostMyr: DecimalString | null;
  feeRuleVersion: number | null;
  originalProfitCny: DecimalString | null;
  originalProfitMyr: DecimalString | null;
  customerRefundTotal: DecimalString;
  appleRecoveredCostCny: DecimalString;
  profitCny: DecimalString | null;
  profitMyr: DecimalString | null;
  costBasis: 'standard' | 'actual';
  remark: string | null;
  version: number;
  createdBy: V2InventoryActor;
  updatedBy: V2InventoryActor | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2GptBankFeeRule {
  version: number;
  paymentFeeRate: DecimalString;
  fixedFeeUsd: DecimalString;
  cardOpeningFeeUsd: DecimalString;
  createdAt: string;
  createdBy: V2InventoryActor | null;
}

export interface V2GptBankFeeRuleList extends PaginatedResult<V2GptBankFeeRule> {
  current: V2GptBankFeeRule | null;
}

export interface V2GptBankFeeRuleInput {
  expectedVersion: number;
  paymentFeeRate: DecimalString;
  fixedFeeUsd: DecimalString;
  cardOpeningFeeUsd: DecimalString;
}

export interface V2SubscriptionAppleWallet {
  id: string;
  appleId: string;
  currency: 'USD';
  balanceUsd: DecimalString;
  balanceCostCny: DecimalString;
  paymentEligible: boolean;
  openingEligible: boolean;
  updatedAt: string;
}

export type V2SubscriptionAppleWalletEntryType =
  | 'gift_card_credit'
  | 'gift_card_redeemed'
  | 'gift_card_withdrawal'
  | 'order_consumption'
  | 'order_consumption_reversal'
  | 'order_upgrade_balance_return'
  | 'order_upgrade_balance_return_reversal'
  | 'opening_balance'
  | 'manual_adjustment'
  | 'account_loss'
  | 'subscription_apple_funding'
  | 'subscription_apple_charge'
  | 'subscription_apple_return'
  | 'subscription_apple_return_reversal'
  | 'subscription_apple_charge_correction'
  | 'subscription_apple_charge_correction_reversal';

export interface V2SubscriptionAppleWalletEntry {
  id: string;
  entryType: V2SubscriptionAppleWalletEntryType;
  direction: 'credit' | 'debit' | 'adjustment';
  amountUsd: DecimalString;
  costCny: DecimalString;
  balanceBeforeUsd: DecimalString;
  balanceAfterUsd: DecimalString;
  subscriptionOrderId: string | null;
  orderNo: string | null;
  remark: string | null;
  createdAt: string;
  createdBy: V2InventoryActor | null;
}

export interface V2SubscriptionAppleWalletOpeningInput {
  expectedUpdatedAt: string;
  amountUsd: DecimalString;
  costCny: DecimalString;
  remark: string;
  idempotencyKey: string;
}

export interface V2SubscriptionAppleRefund {
  id: string;
  orderId: string;
  appleAccountId: string;
  customerRefundAmount: DecimalString;
  customerRefundCurrency: V2SubscriptionOrderSaleCurrency | 'USD';
  customerRefundedAt: string;
  reason: string;
  expectedAppleReturnUsd: DecimalString;
  returnStatus: 'not_required' | 'pending' | 'received' | 'reversed';
  receivedLedgerEntryId: string | null;
  receivedAt: string | null;
  receivedBy: V2InventoryActor | null;
  reversalLedgerEntryId: string | null;
  reversedAt: string | null;
  reversedBy: V2InventoryActor | null;
  version: number;
  createdAt: string;
  createdBy: V2InventoryActor;
  updatedAt: string;
  updatedBy: V2InventoryActor | null;
}

export interface V2SubscriptionApplePaymentConfirmationInput {
  expectedVersion: number;
  expectedAppleUpdatedAt: string;
  idempotencyKey: string;
}

export interface V2SubscriptionAppleAdjustment {
  id: string;
  status: 'applied' | 'reversed';
  previousAppleAccountId: string;
  appleAccountId: string;
  previousAppleId: string;
  appleId: string;
  previousAmountUsd: DecimalString;
  amountUsd: DecimalString;
  previousCostCny: DecimalString;
  costCny: DecimalString;
  reason: string;
  createdAt: string;
  createdBy: V2InventoryActor;
  reversedAt: string | null;
  reversedBy: V2InventoryActor | null;
  canReverse: boolean;
}

export interface V2SubscriptionAppleAdjustmentHistory {
  items: V2SubscriptionAppleAdjustment[];
  cancelledAt: string | null;
  cancelledBy: V2InventoryActor | null;
  version: number;
  canCorrect: boolean;
  canCancel: boolean;
  walletSwitchAllowed: boolean;
}

export interface V2SubscriptionAppleAdjustmentInput {
  expectedVersion: number;
  appleAccountId: string;
  expectedAppleUpdatedAt: string;
  amountUsd: DecimalString;
  reason: string;
}

export interface V2SubscriptionAppleAdjustmentPreview {
  version: number;
  previousAppleAccountId: string;
  appleAccountId: string;
  previousAmountUsd: DecimalString;
  amountUsd: DecimalString;
  previousCostCny: DecimalString;
  costCny: DecimalString;
  movements: Array<{
    accountId: string;
    appleId: string;
    direction: 'credit' | 'debit';
    amountUsd: DecimalString;
    costCny: DecimalString;
    balanceBeforeUsd: DecimalString;
    balanceAfterUsd: DecimalString;
  }>;
  requiresReleaseConfirmation: boolean;
  previewToken: string;
}
