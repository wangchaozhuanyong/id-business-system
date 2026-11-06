import type { DecimalString } from './common.ts';
import type {
  V2SubscriptionOrderCurrency,
  V2SubscriptionOrderSaleCurrency
} from './subscription-orders.ts';

export const V2_CLAUDE_ORDER_PLANS = ['claude_pro', 'claude_max_5x', 'claude_max_20x'] as const;
export type V2ClaudeOrderPlan = (typeof V2_CLAUDE_ORDER_PLANS)[number];

export interface V2ClaudeOrderStockOption {
  stockId: string;
  stockVersion: number;
  accountId: string;
  accountVersion: number;
  email: string;
}

export interface V2ClaudeOrderContact {
  name: string;
  phone: string;
}

export type V2ClaudeOrderTenant = { id: string } | V2ClaudeOrderContact;

export type V2ClaudeOrderVerification =
  | { status: 'unverified' }
  | { status: 'verified'; verifier: V2ClaudeOrderContact };

type ClaudeOrderAccount =
  | { businessType: 'renewal'; email: string }
  | {
      businessType: 'finished_delivery';
      stockId: string;
      stockVersion: number;
      accountVersion: number;
    };

type ClaudeOrderPayment =
  | {
      paymentMethod: 'bank_card';
      cardId: string;
      paidCurrency: V2SubscriptionOrderCurrency;
      saleCurrency: V2SubscriptionOrderSaleCurrency;
    }
  | {
      paymentMethod: 'apple_in_app';
      appleAccountId: string;
      expectedAppleUpdatedAt: string;
      subscriptionFaceUsd: DecimalString;
      paidCurrency: 'USD';
      saleCurrency: V2SubscriptionOrderSaleCurrency | 'USD';
    };

export type V2ClaudeOrderInput = {
  plan: V2ClaudeOrderPlan;
  customerId: string;
  telegram?: string;
  paidAmount: DecimalString;
  saleAmount: DecimalString;
  paidConfirmed: boolean;
  receiptConfirmed: boolean;
  costConfirmed: boolean;
  feeRuleVersion: number;
  emailCostAmount?: DecimalString | null;
  emailCostCurrency?: V2SubscriptionOrderCurrency;
  openedAt: string;
  dueAt?: string;
  remark?: string;
  idempotencyKey: string;
  tenant?: V2ClaudeOrderTenant;
  ownerId?: string;
  verification?: V2ClaudeOrderVerification;
} & ClaudeOrderAccount &
  ClaudeOrderPayment;
