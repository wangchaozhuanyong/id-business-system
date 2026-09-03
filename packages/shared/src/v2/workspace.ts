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

export const V2_RELAY_JOB_STEPS = [
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
  id: number;
  models: string[];
}

export interface V2RelayDeploymentOptions {
  billingAccounts: V2RelaySelectOption[];
  groups: V2RelaySelectOption[];
  proxies: V2RelaySelectOption[];
  referenceAccounts: V2RelayReferenceAccount[];
}

export interface CreateV2RelayJobInput {
  accountLabel: string;
  billingAccount: string;
  creditExpiresAt?: string;
  location?: string;
  projectDisplayName: string;
  projectId: string;
  proxyId?: number | null;
  referenceAccountId: number;
  targetGroupId: number;
}

export interface V2RelayJob {
  accountLabel: string;
  cloudBridgeAccountId: number | null;
  completedSteps: V2RelayJobStep[];
  createdAt: IsoDateTimeString;
  currentStep: V2RelayJobStep | null;
  id: string;
  lastErrorMessage: string | null;
  projectDisplayName: string;
  projectId: string;
  status: V2RelayJobStatus;
  updatedAt: IsoDateTimeString;
}

export interface V2RelayJobList {
  items: V2RelayJob[];
}
