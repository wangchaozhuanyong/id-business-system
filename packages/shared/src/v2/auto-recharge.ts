export const V2_RECHARGE_PLANS = ['plus', 'pro-5x', 'pro-20x'] as const;
export type V2RechargePlan = (typeof V2_RECHARGE_PLANS)[number];
export type V2RechargeAction = 'check' | 'quote' | 'prepare' | 'recheck';
export interface V2RechargeMoney {
  amount: string;
  currency: string;
  amount_minor: number;
}
export interface V2RechargeQuote {
  plan: V2RechargePlan;
  today: V2RechargeMoney | null;
  tax: V2RechargeMoney | null;
  tax_status?: string;
  renewal: V2RechargeMoney | null;
  renewal_interval: string | null;
}
export interface V2RechargeResult {
  status?: string;
  reason?: string;
  stage?: string;
  diagnostics?: {
    step?: 'open_menu' | 'personal_plans' | 'choose_tier' | 'choose_plan' | 'verify_plan';
    error_type?:
      | 'TimeoutError'
      | 'AssertionError'
      | 'Error'
      | 'TargetClosedError'
      | 'UnexpectedError';
    role?: 'button' | 'radio' | 'tab' | 'region';
    matched_count?: number;
    enabled?: boolean;
    selected?: boolean;
    available_plans?: V2RechargePlan[];
  };
  current_plan?: string;
  account_matched?: boolean;
  quote?: V2RechargeQuote;
  network?: { ip: string | null; country: string | null; observedAt: string };
  payment_status?: string;
  payment_outcome?: string;
  subscription_status?: string;
  checkout_identifier?: string;
  nonce?: string;
  card_last4?: string;
  [key: string]: unknown;
}
export interface V2RechargeJob {
  id: string;
  plan: V2RechargePlan;
  action: V2RechargeAction;
  state: 'running' | 'awaiting_confirmation' | 'confirming' | 'finished' | 'unknown';
  result: V2RechargeResult;
  createdAt: string;
  updatedAt: string;
}
export interface V2RechargeDetails {
  number: string;
  expiry: string;
  cvc: string;
  name: string;
  email: string;
  country: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
}
export interface V2RechargeStart {
  id: string;
  sessionJson: string;
  plan: V2RechargePlan;
  action: V2RechargeAction;
  details?: V2RechargeDetails;
}
