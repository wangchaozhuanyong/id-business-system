export const V2_RECHARGE_PLANS = ['go', 'plus', 'pro-5x', 'pro-20x', 'pro-500'] as const;
export type V2RechargePlan = (typeof V2_RECHARGE_PLANS)[number];
// 手工记录已发生的付款；此目录不授予执行器新的自动付款能力。
export const V2_BANK_RECHARGE_PLANS = [
  'go',
  'plus',
  'pro-5x',
  'pro-20x',
  'pro-500',
  'business',
  'enterprise',
  'edu'
] as const;
export interface V2RechargePaymentCap {
  plan: V2RechargePlan;
  currencyCode: string;
  maxAmount: string;
}
export type V2RechargeAction =
  | 'check'
  | 'quote'
  | 'prepare'
  | 'recheck'
  | 'flow'
  | 'bitbrowser'
  | 'server';
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
  error_type?: string;
  browser_error_code?: string;
  payment_failure_reason?: string;
  last_reason?: string;
  proxy_attempt?: number;
  proxy_attempt_limit?: 1 | 10;
  proxy_wait_seconds?: 20;
  session_attempt?: number;
  session_attempt_limit?: number;
  session_elapsed_seconds?: number;
  session_wait_seconds?: number;
  session_refresh_count?: number;
  session_step?: 'page_load' | 'page_refresh' | 'session_read' | 'account_read';
  quote_elapsed_seconds?: number;
  quote_wait_seconds?: number;
  quote_refresh_count?: number;
  page_state?:
    | 'blank'
    | 'loading'
    | 'checkout'
    | 'quote_incomplete'
    | 'official_error'
    | 'network_error';
  stale_profiles_cleaned?: number;
  checkout_replacement_performed?: boolean;
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
  quote_authority?: 'official_checkout_response' | 'official_upgrade_preview';
  operation?: 'subscription_upgrade';
  current_plan_before?: string;
  upgrade_identifier?: string;
  upgrade_invoice_identifier?: string;
  upgrade_payment_intent_identifier?: string;
  subscription_period?: {
    source: 'official_subscription_response';
    start: string;
    end: string;
    account_key: string;
    target_plan: V2RechargePlan;
  };
  three_ds_status?:
    | 'not_required'
    | 'authenticating'
    | 'awaiting_user'
    | 'completed'
    | 'failed'
    | 'unsupported';
  network?: { ip: string | null; country: string | null; observedAt: string };
  payment_status?: string;
  payment_outcome?: string;
  operator_resolution?: 'confirmed_no_bank_request';
  resolved_at?: string;
  resolution_job_id?: string;
  source_job_id?: string;
  verification_job_id?: string;
  resolution_verification_job_id?: string;
  resolution_only?: boolean;
  subscription_status?: string;
  recheck_plan?: V2RechargePlan;
  checkout_identifier?: string;
  nonce?: string;
  card_last4?: string;
  browser_profile_id?: string;
  window_name?: string;
  locked_currency?: string;
  max_amount?: string;
  user_action_required?: boolean;
  [key: string]: unknown;
}
export interface V2RechargeJob {
  id: string;
  chatgptAccountId?: string | null;
  plan: V2RechargePlan;
  action: V2RechargeAction;
  state:
    | 'running'
    | 'awaiting_details'
    | 'awaiting_confirmation'
    | 'awaiting_human_verification'
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
  sessionJson?: string;
  login?: { email: string; password: string; totpSecret?: string; totpAccountId?: string };
  chatgptAccountId?: string;
  cardId?: string;
  plan: V2RechargePlan;
  action: V2RechargeAction;
  addressId?: string;
  manualAddress?: true;
  details?: V2RechargeDetails;
  lockedCurrency?: string;
  maxAmount?: string;
  authorizeSinglePayment?: true;
  proxyId?: string;
  proxyCountryCode?: string;
}

export interface V2RechargeDetailsSubmission {
  addressId: string;
  details: V2RechargeDetails;
}

export interface V2RechargeBrowserOptions {
  sessionWaitMinutes: number;
  sessionRetryLimit: number;
  proxyMode: 'dynamic' | 'static';
  staticHost: string;
  staticPort: number;
  dynamicProvider: 'common' | 'rola' | 'doveip' | 'cloudam';
  refreshIp: boolean;
  ipCheckService: 'ip-api' | 'ip123in' | 'luminati';
  os: 'MacIntel' | 'Win32' | 'Linux x86_64';
  languageFromIp: boolean;
  language: string;
  displayLanguageFromIp: boolean;
  displayLanguage: string;
  timezoneFromIp: boolean;
  timezone: string;
  positionFromIp: boolean;
  latitude: number;
  longitude: number;
  accuracy: number;
  syncTabs: boolean;
  syncCookies: boolean;
  syncLocalStorage: boolean;
}

export const V2_RECHARGE_BROWSER_DEFAULTS: Readonly<V2RechargeBrowserOptions> = {
  sessionWaitMinutes: 2,
  sessionRetryLimit: 2,
  proxyMode: 'dynamic',
  staticHost: '',
  staticPort: 8080,
  dynamicProvider: 'common',
  refreshIp: true,
  ipCheckService: 'ip-api',
  os: 'MacIntel',
  languageFromIp: false,
  language: 'zh-CN',
  displayLanguageFromIp: false,
  displayLanguage: 'zh-CN',
  timezoneFromIp: true,
  timezone: 'Asia/Shanghai',
  positionFromIp: true,
  latitude: 0,
  longitude: 0,
  accuracy: 100,
  syncTabs: false,
  syncCookies: false,
  syncLocalStorage: false
};

export interface V2RechargeStaticProxyCredentials {
  username: string;
  password: string;
}

export interface V2RechargeServerProxySettings {
  proxyId: string | null;
  proxy: {
    id: string;
    countryCode: string;
    kind: 'dynamic_residential' | 'static_residential' | 'mobile';
    connectionMode: 'extraction' | 'direct';
    protocol: 'http' | 'https' | 'socks5';
    status: 'active' | 'disabled';
    remark1: string | null;
  } | null;
  legacyConfigured: boolean;
}

export interface V2RechargeBitBrowserSettings {
  proxyId?: string | null;
  connectorUrl: string;
  localApiUrl: string;
  localApiTokenConfigured: boolean;
  localApiTokenMask: string | null;
  connectorTokenConfigured: boolean;
  connectorTokenMask: string | null;
  groupName: string;
  tagName: string;
  proxyType: 'http' | 'https' | 'socks5';
  dynamicProxyUrlConfigured: boolean;
  dynamicProxyUrlMask: string | null;
  browserOptions?: V2RechargeBrowserOptions;
  staticProxyCredentialsConfigured?: boolean;
  updatedAt: string | null;
}

export interface V2RechargeBrowserCatalog {
  groups: { id: string; name: string }[];
  tags: { id: string; name: string }[];
}

export interface V2RechargeBrowserCatalogAccess {
  connectorUrl: string;
  connectorToken: string;
  localApiUrl: string;
  localApiToken: string;
}

export interface UpdateV2RechargeBitBrowserSettingsInput {
  proxyId?: string | null;
  serverMode?: boolean;
  directMode?: boolean;
  connectorUrl: string;
  localApiUrl: string;
  localApiToken?: string;
  connectorToken?: string;
  groupName: string;
  tagName: string;
  proxyType: 'http' | 'https' | 'socks5';
  dynamicProxyUrl?: string;
  browserOptions?: V2RechargeBrowserOptions;
  staticProxyCredentials?: V2RechargeStaticProxyCredentials;
  clearStaticProxyCredentials?: boolean;
}

export interface V2RechargeBitBrowserStart {
  cardId?: string;
  billingName?: string;
  id: string;
  plan: V2RechargePlan;
  addressId: string;
  windowName: string;
  lockedCurrency: string;
  maxAmount: string;
  authorizeSinglePayment: true;
  proxyId?: string;
  proxyCountryCode?: string;
  chatgptAccountId?: string;
  useSavedCredentials?: boolean;
  expectedEmail?: string;
}

export interface V2RechargeBitBrowserRecheckStart {
  id: string;
  sourceJobId: string;
  plan: V2RechargePlan;
  windowName: string;
}

export interface V2RechargeBitBrowserLaunch {
  id: string;
  mode: 'payment';
  connectorUrl: string;
  connectorToken: string;
  agentToken: string;
  savedLogin?: { email: string; password: string };
  bitBrowser: {
    localApiUrl: string;
    localApiToken: string;
    groupName: string;
    tagName: string;
    proxyType: 'http' | 'https' | 'socks5';
    dynamicProxyUrl: string;
    browserOptions?: V2RechargeBrowserOptions;
    staticProxyCredentials?: V2RechargeStaticProxyCredentials;
  };
  address: Pick<V2RechargeAddress, 'id' | 'line1' | 'country' | 'city' | 'state' | 'postalCode'>;
  safety: {
    lockedCurrency: string;
    maxAmount: string;
    maxAmountMinor: number;
    authorizeSinglePayment: true;
  };
}

export interface V2RechargeBitBrowserOpenStart {
  id: string;
  windowName: string;
  directMode?: boolean;
}

export interface V2RechargeBitBrowserOpenLaunch {
  id: string;
  mode: 'open_browser';
  connectorUrl: string;
  connectorToken: string;
  agentToken: string;
  bitBrowser: V2RechargeBitBrowserLaunch['bitBrowser'];
}

export interface V2RechargeBitBrowserRecheckLaunch {
  id: string;
  mode: 'recheck';
  upgradeIdentifier?: string;
  connectorUrl: string;
  connectorToken: string;
  agentToken: string;
  bitBrowser: V2RechargeBitBrowserLaunch['bitBrowser'];
}

export interface V2RechargeResolveNoBankRequest {
  confirmNoBankRequest: true;
  verificationJobId: string;
}

export interface V2RechargeBitBrowserResolutionLaunch {
  id: string;
  mode: 'resolve_unknown_payment';
  connectorUrl: string;
  connectorToken: string;
  agentToken: string;
  plan: V2RechargePlan;
  accountKey: string;
  checkoutIdentifier: string;
  sourceJobId: string;
  verificationJobId: string;
}

export const V2_RECHARGE_ADDRESS_STATUSES = ['unused', 'used', 'disabled'] as const;
export type V2RechargeAddressStatus = (typeof V2_RECHARGE_ADDRESS_STATUSES)[number];

export interface V2RechargeAddress {
  id: string;
  line1: string;
  country: string;
  city: string;
  state: string;
  line2?: string | null;
  postalCode: string;
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
