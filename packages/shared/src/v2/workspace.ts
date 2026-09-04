import type { IsoDateTimeString } from './common.js';

export const V2_WORKSPACE_SHORTCUT_LIMITS = {
  count: 20,
  name: 60,
  url: 2048
} as const;

export const V2_SAVED_TOTP_ACCOUNT_LIMITS = {
  count: 100,
  issuer: 120,
  name: 60,
  secret: 4096
} as const;

export const V2_TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;

export type V2TotpAlgorithm = (typeof V2_TOTP_ALGORITHMS)[number];

export const V2_MAIL_VIEWER_LIMITS = {
  batchLength: 12_000,
  batchLines: 20,
  credential: 330,
  email: 254,
  label: 60,
  providerCredential: 256,
  queryCode: 64,
  messages: 20
} as const;

export const V2_WEBSITE_MONITOR_LIMITS = {
  redirects: 5,
  requestTimeoutMs: 10_000,
  url: 2048
} as const;

export const V2_WEBSITE_MONITOR_STATUSES = ['healthy', 'warning', 'down'] as const;
export const V2_WEBSITE_MONITOR_ERROR_CATEGORIES = [
  'connection',
  'dns',
  'redirect',
  'timeout',
  'tls'
] as const;

export type V2WebsiteMonitorStatus = (typeof V2_WEBSITE_MONITOR_STATUSES)[number];
export type V2WebsiteMonitorErrorCategory = (typeof V2_WEBSITE_MONITOR_ERROR_CATEGORIES)[number];

export interface CheckV2WebsiteInput {
  url: string;
}

export interface V2WebsiteMonitorHop {
  durationMs: number;
  statusCode: number;
  url: string;
}

export interface V2WebsiteMonitorTls {
  authorized: boolean;
  daysRemaining: number | null;
  expiresAt: IsoDateTimeString | null;
  protocol: string | null;
}

export interface V2WebsiteMonitorResult {
  checkedAt: IsoDateTimeString;
  errorCategory: V2WebsiteMonitorErrorCategory | null;
  finalUrl: string;
  hops: V2WebsiteMonitorHop[];
  message: string;
  responseTimeMs: number | null;
  status: V2WebsiteMonitorStatus;
  statusCode: number | null;
  tls: V2WebsiteMonitorTls | null;
}

export const V2_MEDIA_RESOLVER_LIMITS = {
  inputLength: 4096,
  downloadBytes: 256 * 1024 * 1024,
  downloadOptions: 6,
  ticketMinutes: 10
} as const;

export const V2_MEDIA_PLATFORMS = [
  'douyin',
  'tiktok',
  'youtube',
  'instagram',
  'x',
  'bilibili',
  'facebook',
  'vimeo',
  'reddit',
  'soundcloud',
  'twitch',
  'pinterest',
  'dailymotion',
  'weibo'
] as const;

export type V2MediaPlatform = (typeof V2_MEDIA_PLATFORMS)[number];
export type V2MediaType = 'video' | 'audio' | 'image';

export interface ResolveV2MediaInput {
  url: string;
}

export interface V2MediaDownloadOption {
  downloadToken: string;
  estimatedBytes: number | null;
  extension: string;
  height: number | null;
  label: string;
  width: number | null;
}

export interface V2MediaResolveResult {
  author: string | null;
  durationSeconds: number | null;
  engine: 'f2' | 'yt-dlp';
  expiresAt: IsoDateTimeString;
  mediaType: V2MediaType;
  options: V2MediaDownloadOption[];
  platform: V2MediaPlatform;
  title: string;
}

export const V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY = {
  defaultDays: 30,
  minDays: 1,
  maxDays: 365,
  warningHours: 72
} as const;

export const V2_MAIL_PROVIDERS = ['gmail', 'icloud', 'microsoft'] as const;
export const V2_PASSWORD_MAIL_PROVIDERS = ['gmail', 'icloud'] as const;
export const V2_MANAGED_MAILBOX_STATUSES = ['active', 'disabled', 'auth_failed'] as const;
export const V2_MAILBOX_OAUTH_STATUSES = ['pending', 'succeeded', 'failed'] as const;

export type V2MailProvider = (typeof V2_MAIL_PROVIDERS)[number];
export type V2PasswordMailProvider = (typeof V2_PASSWORD_MAIL_PROVIDERS)[number];
export type V2ManagedMailboxStatus = (typeof V2_MANAGED_MAILBOX_STATUSES)[number];
export type V2MailboxOAuthStatus = (typeof V2_MAILBOX_OAUTH_STATUSES)[number];

export interface V2WorkspaceShortcut {
  id: string;
  name: string;
  url: string;
  sortOrder: number;
  createdAt: IsoDateTimeString;
  updatedAt: IsoDateTimeString;
}

export interface V2WorkspaceShortcutList {
  items: V2WorkspaceShortcut[];
}

export interface CreateV2WorkspaceShortcutInput {
  name: string;
  url: string;
}

export interface UpdateV2WorkspaceShortcutInput {
  name: string;
  url: string;
}

export interface ReorderV2WorkspaceShortcutsInput {
  shortcutIds: string[];
}

export interface V2SavedTotpAccount {
  id: string;
  name: string;
  issuer: string | null;
  algorithm: V2TotpAlgorithm;
  digits: number;
  period: number;
  token: string;
  expiresAt: IsoDateTimeString;
  createdAt: IsoDateTimeString;
  updatedAt: IsoDateTimeString;
}

export interface V2SavedTotpAccountList {
  items: V2SavedTotpAccount[];
}

export interface CreateV2SavedTotpAccountInput {
  name: string;
  secret: string;
}

export interface UpdateV2SavedTotpAccountInput {
  name: string;
  secret?: string;
}

export interface V2MailViewerQueryInput {
  queryCode: string;
  limit: number;
}

export interface V2MailViewerMessage {
  body: string;
  from: string;
  savedAt: string;
  subject: string;
  to: string;
}

export interface V2MailViewerQueryResult {
  email: string;
  items: V2MailViewerMessage[];
  provider: V2MailProvider;
  queriedAt: IsoDateTimeString;
}

export interface V2ManagedMailbox {
  id: string;
  email: string;
  label: string | null;
  provider: V2MailProvider;
  status: V2ManagedMailboxStatus;
  queryCode: string | null;
  queryCodeHint: string;
  queryCodeExpiresAt: IsoDateTimeString;
  lastVerifiedAt: IsoDateTimeString | null;
  lastQueriedAt: IsoDateTimeString | null;
  createdAt: IsoDateTimeString;
  updatedAt: IsoDateTimeString;
}

export interface V2ManagedMailboxList {
  items: V2ManagedMailbox[];
  page: number;
  pageSize: number;
  total: number;
}

export interface V2ManagedMailboxListQuery {
  page?: number;
  pageSize?: number;
  provider?: V2MailProvider;
  q?: string;
  status?: V2ManagedMailboxStatus;
}

export interface V2ManagedMailboxQueryCodeSettings {
  validityDays: number;
  defaultValidityDays: number;
  minValidityDays: number;
  maxValidityDays: number;
  rotationMode: 'manual';
  updatedAt: IsoDateTimeString | null;
}

export interface UpdateV2ManagedMailboxQueryCodeSettingsInput {
  validityDays: number;
  applyToExisting: boolean;
}

export interface UpdateV2ManagedMailboxQueryCodeSettingsResult extends V2ManagedMailboxQueryCodeSettings {
  updatedExistingCount: number;
}

export interface CreateV2ManagedMailboxInput {
  email: string;
  provider: V2PasswordMailProvider;
  appPassword: string;
  label?: string;
}

export interface CreateV2ManagedMailboxResult {
  mailbox: V2ManagedMailbox;
  buyerCredential: string;
}

export interface UpdateV2ManagedMailboxStatusInput {
  status: Extract<V2ManagedMailboxStatus, 'active' | 'disabled'>;
}

export interface UpdateV2ManagedMailboxCredentialInput {
  appPassword: string;
}

export interface RotateV2ManagedMailboxQueryCodeResult {
  mailbox: V2ManagedMailbox;
  buyerCredential: string;
}

export interface CreateV2ManagedMailboxBatchInput {
  items: CreateV2ManagedMailboxInput[];
}

export interface V2ManagedMailboxBatchResultItem {
  email: string;
  index: number;
  mailbox?: V2ManagedMailbox;
  message?: string;
  status: 'succeeded' | 'failed';
}

export interface CreateV2ManagedMailboxBatchResult {
  failed: number;
  items: V2ManagedMailboxBatchResultItem[];
  succeeded: number;
  total: number;
}

export interface StartV2MicrosoftMailboxAuthorizationInput {
  email: string;
  label?: string;
  mailboxId?: string;
}

export interface StartV2MicrosoftMailboxAuthorizationResult {
  authorizationId: string;
  authorizationUrl: string;
  expiresAt: IsoDateTimeString;
}

export interface V2MicrosoftMailboxAuthorizationStatus {
  authorizationId: string;
  failureMessage: string | null;
  mailboxId: string | null;
  status: V2MailboxOAuthStatus;
}

export const V2_RELAY_JOB_STATUSES = [
  'draft',
  'running',
  'action_required',
  'completed',
  'failed'
] as const;

export const V2_RELAY_DEPLOYMENT_MODES = [
  'antigravity_subscription',
  'gemini_api',
  'vertex'
] as const;

export const V2_RELAY_JOB_STEPS_BY_MODE = {
  antigravity_subscription: [
    'authorize_account',
    'set_privacy',
    'sync_models',
    'configure_models',
    'test_models',
    'attach_group'
  ],
  gemini_api: [
    'verify_provider_models',
    'test_provider_text',
    'test_provider_tts',
    'create_cloudbridge_account',
    'test_models',
    'attach_group'
  ],
  vertex: [
    'create_project',
    'link_billing',
    'enable_services',
    'create_service_account',
    'grant_permissions',
    'create_service_account_key',
    'create_cloudbridge_account',
    'test_models',
    'attach_group'
  ]
} as const;

export const V2_RELAY_JOB_STEPS = [
  'authorize_account',
  'set_privacy',
  'sync_models',
  'configure_models',
  'verify_provider_models',
  'test_provider_text',
  'test_provider_tts',
  'create_project',
  'link_billing',
  'enable_services',
  'create_service_account',
  'grant_permissions',
  'create_service_account_key',
  'create_cloudbridge_account',
  'test_models',
  'attach_group'
] as const;

export type V2RelayDeploymentMode = (typeof V2_RELAY_DEPLOYMENT_MODES)[number];
export type V2RelayJobStatus = (typeof V2_RELAY_JOB_STATUSES)[number];
export type V2RelayJobStep = (typeof V2_RELAY_JOB_STEPS)[number];

export interface V2RelayConnectionStatus {
  callbackUrl: string;
  cloudBridgeConnected: boolean;
  cloudBridgeEmail: string | null;
  cloudBridgeOrigin: string;
  googleAuthorized: boolean;
  googleEmail: string | null;
  googleOAuthConfigured: boolean;
}

export interface SaveV2RelayGoogleOAuthInput {
  clientId: string;
  clientSecret?: string;
}

export interface StartV2RelayGoogleAuthorizationResult {
  authorizationUrl: string;
  expiresAt: IsoDateTimeString;
}

export interface LoginV2RelayCloudBridgeInput {
  email: string;
  password?: string;
  tempToken?: string;
  totpCode?: string;
}

export interface LoginV2RelayCloudBridgeResult {
  connected: boolean;
  email: string | null;
  tempToken?: string;
  twoFactorRequired: boolean;
}

export interface V2RelaySelectOption {
  id: number | string;
  label: string;
}

export interface V2RelayReferenceAccount extends V2RelaySelectOption {
  allowOverages?: boolean;
  concurrency?: number;
  id: number;
  loadFactor?: number;
  mixedScheduling?: boolean;
  models: string[];
  priority?: number;
  rateMultiplier?: number;
}

export interface V2RelayDeploymentOptions {
  billingAccounts: V2RelaySelectOption[];
  geminiGroups: V2RelaySelectOption[];
  proxies: V2RelaySelectOption[];
  subscriptionReferenceAccounts: V2RelayReferenceAccount[];
  vertexReferenceAccounts: V2RelayReferenceAccount[];
  antigravityGroups: V2RelaySelectOption[];
}

export interface CreateV2RelayJobInput {
  accountConcurrency?: number;
  accountLabel: string;
  accountLoadFactor?: number;
  accountPriority?: number;
  accountRateMultiplier?: number;
  allowOverages?: boolean;
  apiKey?: string;
  billingAccount?: string;
  creditExpiresAt?: string;
  deploymentKey: string;
  googleEmail?: string;
  location?: string;
  mode: V2RelayDeploymentMode;
  mixedScheduling?: boolean;
  projectDisplayName?: string;
  projectId?: string;
  proxyId?: number | null;
  referenceAccountId?: number;
  selectedModels?: string[];
  targetGroupId: number;
}

export interface StartV2RelaySubscriptionAuthorizationResult {
  authorizationUrl: string;
  expiresAt: IsoDateTimeString;
}

export interface CompleteV2RelaySubscriptionAuthorizationInput {
  callbackUrl: string;
}

export interface V2RelayJob {
  accountLabel: string;
  cloudBridgeAccountId: number | null;
  completedSteps: V2RelayJobStep[];
  createdAt: IsoDateTimeString;
  currentStep: V2RelayJobStep | null;
  deploymentKey: string;
  id: string;
  lastErrorMessage: string | null;
  mode: V2RelayDeploymentMode;
  models: string[];
  projectDisplayName: string | null;
  projectId: string | null;
  status: V2RelayJobStatus;
  totalSteps: number;
  updatedAt: IsoDateTimeString;
}

export interface V2RelayJobList {
  items: V2RelayJob[];
}

export const V2_GOOGLE_SHEETS_REPORT_NAMES = ['订单', '加卡', '续费', '财务汇总'] as const;

export interface V2GoogleSheetsSyncStatus {
  authorized: boolean;
  callbackUrl: string;
  clientId: string | null;
  configured: boolean;
  enabled: boolean;
  excludedData: string[];
  lastAttemptAt: IsoDateTimeString | null;
  lastErrorMessage: string | null;
  lastSucceededAt: IsoDateTimeString | null;
  reportNames: string[];
  spreadsheetUrl: string | null;
  syncIntervalSeconds: number;
  syncing: boolean;
}

export interface SaveV2GoogleSheetsSyncConfigInput {
  clientId: string;
  clientSecret?: string;
}

export interface StartV2GoogleSheetsAuthorizationResult {
  authorizationUrl: string;
  expiresAt: IsoDateTimeString;
}

export interface UpdateV2GoogleSheetsSyncStateInput {
  enabled: boolean;
}

export interface RunV2GoogleSheetsSyncResult {
  skipped: boolean;
  status: V2GoogleSheetsSyncStatus;
}
