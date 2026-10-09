export const ONLINE_RECHARGE_SOURCE_SHA = 'ba6cf96312a6953e62edb9d74299d438d12549df';
export const ONLINE_RECHARGE_PLANS = ['plus', 'pro_5x', 'pro_20x'] as const;
export type OnlineRechargePlan = (typeof ONLINE_RECHARGE_PLANS)[number];
export const ONLINE_RECHARGE_CONFIRMED_PLAN_NAMES: Record<OnlineRechargePlan, readonly string[]> = {
  plus: ['plus', 'chatgptplus', 'chatgptplusplan'],
  pro_5x: ['pro_5x', 'pro5x', 'chatgptprolite'],
  pro_20x: ['pro_20x', 'pro20x', 'chatgptpro']
};
export const ONLINE_RECHARGE_SECTIONS = [
  'cards',
  'proxies',
  'addresses',
  'cdks',
  'jobs',
  'automation',
  'billing',
  'runtime-logs',
  'login-logs',
  'browser-pool',
  'sessions',
  'renewal'
] as const;
export type OnlineRechargeSection = (typeof ONLINE_RECHARGE_SECTIONS)[number];
export type OnlineRechargeStatus =
  | 'queued'
  | 'running'
  | 'awaiting_credentials'
  | 'awaiting_review'
  | 'succeeded'
  | 'failed';
export type OnlineRechargeOperation =
  | 'recharge'
  | 'debug'
  | 'subscription'
  | 'renewal'
  | 'proxy_test'
  | 'config_test'
  | 'browser_manage'
  | 'notification';
export interface OnlineRechargeWorkerRpc {
  method: string;
  args?: Record<string, unknown>;
  taskId?: string;
  workerId?: string;
  leaseId?: string;
  leaseVersion?: number;
}
export const ONLINE_RECHARGE_DEFAULTS = {
  maxConcurrent: 1,
  maintenance: false,
  cardMaxSubscriptionCount: 2,
  cardMaxDeclineCount: 3,
  paymentMaxCardAttempts: 3,
  paymentRegion: 'PH',
  browserMode: 'pool',
  browserPoolSize: 2,
  gptApiEnabled: false,
  gptApiBaseUrl: 'https://kc.vpss.eu.cc/',
  gptApiTimeoutMs: 30000,
  telegramEnabled: false,
  telegramAdminEnabled: false,
  telegramGroupEnabled: false,
  telegramOnAdminLogin: true,
  telegramNotifySuccess: false,
  telegramNotifyFailure: false,
  telegramNotifyCardEmpty: false,
  hcaptchaEnabled: true,
  hcaptchaDisableVlm: false,
  hcaptchaSolverTimeoutMs: 240000,
  captchaPlatformBaseUrl: '',
  captchaPlatformTimeoutMs: 120000,
  vlmBaseUrl: 'https://api.openai.com/v1',
  vlmModel: 'gpt-5.5',
  vlmTimeoutMs: 45000,
  cdpPort: 9222,
  planNamePlus: 'chatgptplusplan',
  planNamePro5x: 'chatgptprolite',
  planNamePro20x: 'chatgptpro'
} as const;
export const ONLINE_RECHARGE_SECRET_KEYS = [
  'gptApiKey',
  'telegramBotToken',
  'telegramAdminChatId',
  'telegramGroupChatId',
  'cardSupplierWebhookSecret',
  'externalCardsApiKey',
  'captchaPlatformApiKey',
  'vlmApiKey'
] as const;
export const ONLINE_RECHARGE_PERMISSION = {
  read: 'id_business_v2.online_recharge.read',
  manage: 'id_business_v2.online_recharge.manage',
  sensitive: 'id_business_v2.online_recharge.sensitive'
} as const;
