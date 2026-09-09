export const V2_RECHARGE_PLANS = ['plus', 'pro-5x', 'pro-20x'] as const;
export type V2RechargePlan = (typeof V2_RECHARGE_PLANS)[number];
export type V2RechargeAction = 'check' | 'quote' | 'prepare' | 'recheck' | 'flow';
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
    step?:
      | 'open_menu'
      | 'pricing_page'
      | 'personal_plans'
      | 'choose_tier'
      | 'choose_plan'
      | 'verify_plan';
    error_type?:
      | 'TimeoutError'
      | 'AssertionError'
      | 'Error'
      | 'TargetClosedError'
      | 'UnexpectedError';
    role?: 'button' | 'link' | 'radio' | 'tab' | 'region';
    matched_count?: number;
    enabled?: boolean;
    selected?: boolean;
    available_plans?: V2RechargePlan[];
  };
  current_plan?: string;
  account_matched?: boolean;
  quote?: V2RechargeQuote;
  initial_quote?: V2RechargeQuote;
  quote_authority?: 'official_checkout_response';
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
  state:
    | 'running'
    | 'awaiting_details'
    | 'awaiting_confirmation'
    | 'confirming'
    | 'finished'
    | 'unknown';
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
  addressId?: string;
  details?: V2RechargeDetails;
}

export interface V2RechargeDetailsSubmission {
  addressId: string;
  details: V2RechargeDetails;
}

export const V2_RECHARGE_ADDRESS_STATUSES = ['unused', 'used', 'disabled'] as const;
export type V2RechargeAddressStatus = (typeof V2_RECHARGE_ADDRESS_STATUSES)[number];

export interface V2RechargeAddress {
  id: string;
  line1: string;
  country: 'US';
  city: 'Portland';
  state: 'OR';
  postalCode: '97204';
  status: V2RechargeAddressStatus;
  usedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2RechargeAddressListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: V2RechargeAddressStatus | 'all';
}

export interface V2RechargeAddressList {
  items: V2RechargeAddress[];
  total: number;
  page: number;
  pageSize: number;
  totals: Record<V2RechargeAddressStatus, number>;
}

export interface ImportV2RechargeAddressesInput {
  streets: string[];
}

export interface ImportV2RechargeAddressesResult {
  imported: number;
  duplicated: number;
  rejected: number;
}
