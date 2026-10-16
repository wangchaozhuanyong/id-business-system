export const AUTO_REGISTRATION_WORKSPACE_PATH = '/api/id-business-v2/auto-registration/workspace/';

export interface AutoRegistrationStatus {
  ready: boolean;
  workspacePath: string;
  version: string;
  sourceCommit: string;
}

export interface AutoRegistrationWorkspaceSession {
  expiresAt: string;
}

export const autoRegistrationPages = [
  { path: '/', title: '注册控制台' },
  { path: '/accounts', title: '注册结果与凭据' },
  { path: '/email-services', title: '邮箱服务' },
  { path: '/settings', title: '系统设置' }
] as const;

export type AutoRegistrationPage = (typeof autoRegistrationPages)[number]['path'];
export const appleMailboxPage = { path: '/apple-mailboxes', title: '苹果隐藏邮箱' } as const;
export type AutoRegistrationParentPage = AutoRegistrationPage | typeof appleMailboxPage.path;

export type AppleMailboxRegistrationStatus = 'unknown' | 'unregistered' | 'registered';
export type AppleMailboxTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'awaiting_review';
export type AppleMailboxResultKind = 'new_registration' | 'existing_account' | 'failed' | null;
export type AppleMailboxSyncStatus =
  | 'not_ready'
  | 'not_started'
  | 'awaiting_identity'
  | 'blocked'
  | 'quarantined'
  | 'pending'
  | 'syncing'
  | 'saved'
  | 'failed'
  | 'conflict';

export type AppleMailboxRegistrationStage =
  | 'queued'
  | 'signup'
  | 'password'
  | 'verification_code'
  | 'verification_validate'
  | 'create_account'
  | 'workspace'
  | 'select_workspace'
  | 'redirect'
  | 'oauth'
  | 'identity'
  | 'account_save'
  | 'sync';
export interface AppleMailboxFailure {
  stage: AppleMailboxRegistrationStage;
  errorKind:
    | 'http_rejected'
    | 'network_error'
    | 'unknown'
    | 'account_creation_failed'
    | 'user_exists';
  httpStatus: number | null;
  elapsedMs: number;
  observedAt: string;
}

export interface AppleMailboxRecord {
  revision: number;
  registrationStatus: AppleMailboxRegistrationStatus;
  registrationIp: string | null;
  registrationCountryCode?: string | null;
  registeredAt?: string | null;
  registrationIpSource: 'manual' | 'observed' | null;
  source: 'manual' | 'automatic' | 'account_history' | null;
  note: string | null;
  markedAt: string | null;
  operatorId: string | null;
  activeTaskUuid: string | null;
  lastTaskUuid: string | null;
  lastResultKind: AppleMailboxResultKind;
  taskStatus: AppleMailboxTaskStatus | null;
  creationConfirmed?: boolean;
  authorizationStatus?: 'pending' | 'complete' | null;
  syncStatus?: AppleMailboxSyncStatus;
  localSaveStatus?: 'not_ready' | 'not_started' | 'pending' | 'saved' | 'failed';
  identityStatus?: 'not_verified' | 'awaiting_identity' | 'verified' | 'mismatch';
  passwordStatus?: 'not_started' | 'saved' | 'submitted';
  syncErrorKind?: string | null;
  stage?: AppleMailboxRegistrationStage | null;
  reason?:
    | 'account_creation_failed'
    | 'identity_missing'
    | 'identity_mismatch'
    | 'password_missing'
    | 'email_conflict'
    | 'local_save_failed'
    | 'existing_account_suspected'
    | null;
  lastHttpStatus?: number | null;
  proxySource?: 'system' | 'explicit' | 'default';
  proxyId?: string | null;
  mailboxSelection?: 'specified' | 'automatic';
  firstFailure?: AppleMailboxFailure | null;
  systemAccountId?: string | null;
  errorKind?: string | null;
}

export interface AppleMailboxRow {
  aliasId: string;
  email: string;
  primaryEmail: string | null;
  mailboxStatus: 'ACTIVE' | 'DISABLED';
  authorizationValid: boolean;
  primaryAvailable: boolean;
  registrationStatus: AppleMailboxRegistrationStatus;
  registrationIp: string | null;
  registrationCountryCode?: string | null;
  registeredAt?: string | null;
  registrationIpSource: 'manual' | 'observed' | null;
  note: string | null;
  source: 'manual' | 'automatic' | 'account_history' | null;
  updatedAt: string | null;
  revision: number;
  taskUuid: string | null;
  activeTaskUuid?: string | null;
  taskStatus: AppleMailboxTaskStatus | null;
  creationConfirmed?: boolean;
  authorizationStatus?: 'pending' | 'complete' | null;
  canRegister: boolean;
  blockedReason: string | null;
  syncStatus?: AppleMailboxSyncStatus;
  localSaveStatus?: AppleMailboxRecord['localSaveStatus'];
  identityStatus?: AppleMailboxRecord['identityStatus'];
  stage?: AppleMailboxRecord['stage'];
  reason?: AppleMailboxRecord['reason'];
  syncErrorKind?: AppleMailboxRecord['syncErrorKind'];
  proxySource?: AppleMailboxRecord['proxySource'];
  proxyId?: AppleMailboxRecord['proxyId'];
  mailboxSelection?: AppleMailboxRecord['mailboxSelection'];
  firstFailure?: AppleMailboxRecord['firstFailure'];
}

export interface AppleMailboxListQuery {
  page: number;
  pageSize: number;
  q: string;
  registrationStatus: AppleMailboxRegistrationStatus | '';
  sortBy: 'email' | 'updatedAt';
  sortOrder: 'asc' | 'desc';
}

export interface AppleMailboxPageResult {
  items: AppleMailboxRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AppleMailboxTarget {
  aliasId: string;
  revision: number;
}
export interface AppleMailboxRegistrationOptions {
  proxyId?: string;
  auto_upload_cpa?: boolean;
  cpa_service_ids?: number[];
  auto_upload_sub2api?: boolean;
  sub2api_service_ids?: number[];
  auto_upload_tm?: boolean;
  tm_service_ids?: number[];
}
export interface AppleMailboxStartInput extends AppleMailboxRegistrationOptions {
  aliasId?: string;
  revision?: number;
}
export interface AppleMailboxBatchInput extends AppleMailboxRegistrationOptions {
  targets?: AppleMailboxTarget[];
  count: number;
  concurrency: number;
  mode: 'pipeline' | 'parallel';
  interval_min: number;
  interval_max: number;
}
export interface AppleMailboxConsoleOptions {
  items: AppleMailboxRow[];
  proxies: Array<{ id: string; label: string; countryCode?: string | null }>;
  total: number;
  available: number;
}
export interface AppleMailboxBatch {
  batchId: string;
  status?: AppleMailboxTaskStatus;
  taskUuids: string[];
  records: AppleMailboxRecord[];
  accepted: number;
  requested: number;
  skipped: Array<{ aliasId: string; reason: string }>;
  tasks?: AppleMailboxTask[];
}
export interface AppleMailboxMarkInput {
  items: AppleMailboxTarget[];
  registrationStatus: AppleMailboxRegistrationStatus;
  registrationIp: string | null;
  note: string;
}
export interface AppleMailboxManualSyncPreview {
  items: Array<{
    aliasId: string;
    email: string;
    revision: number;
    status: 'create' | 'exists' | 'conflict' | 'deleted' | 'busy' | 'stale' | 'ineligible';
    accountId: string | null;
  }>;
  total: number;
  creatable: number;
}
export interface AppleMailboxManualSyncResult {
  items: Array<{
    aliasId: string;
    status: 'saved' | 'failed' | 'conflict' | 'skipped';
    accountId: string | null;
  }>;
  synchronized: number;
  failed: number;
  skipped: number;
}
export interface AppleMailboxFlowResponseDetails {
  errorSignal: 'none' | 'error' | 'errors' | 'both';
  errorShape: 'missing' | 'null' | 'object' | 'string' | 'list' | 'boolean' | 'number' | 'other';
  errorsShape: 'missing' | 'null' | 'object' | 'string' | 'list' | 'boolean' | 'number' | 'other';
  errorKind: 'none' | 'account_creation_failed' | 'user_exists' | 'other';
  pageShape:
    | 'missing'
    | 'non_object'
    | 'type_missing'
    | 'type_non_string'
    | 'type_known'
    | 'type_unknown';
}
export interface AppleMailboxFlowObservation {
  observedAt: string;
  httpStatus: number | null;
  contentType: 'json' | 'html' | 'other' | 'missing';
  jsonKind: 'object' | 'other' | 'invalid' | 'not_checked';
  pageKind: 'new_account' | 'existing_account' | 'missing' | 'unknown' | 'not_checked';
  officialOrigin: boolean;
  redirectHosts: Array<'auth_openai' | 'sentinel_openai' | 'chatgpt' | 'other'>;
  redirectsTruncated: boolean;
  requestIdPresent: boolean;
  requestIdSha256: string | null;
  decision: 'accepted' | 'rejected' | 'observed';
  reason:
    | 'http_status'
    | 'untrusted_origin'
    | 'invalid_json'
    | 'upstream_error'
    | 'unexpected_page'
    | null;
  responseDetails?: AppleMailboxFlowResponseDetails;
}
export interface AppleMailboxFlowEvidence {
  version: 1 | 2;
  authorize?: AppleMailboxFlowObservation;
  signup?: AppleMailboxFlowObservation;
  password?: AppleMailboxFlowObservation;
}

export interface AppleMailboxTask {
  flowEvidence?: AppleMailboxFlowEvidence;
  taskUuid: string;
  status: AppleMailboxTaskStatus;
  logs: string[];
  record: AppleMailboxRecord;
  resultKind: AppleMailboxResultKind;
  syncStatus?: AppleMailboxSyncStatus;
}
export type AutoRegistrationDraft = Record<string, string | boolean>;

export type AutoRegistrationChildMessage =
  | { type: 'id-registration:ready'; page: AutoRegistrationPage }
  | { type: 'id-registration:draft'; page: AutoRegistrationPage; values: unknown }
  | { type: 'id-registration:account-open'; page: '/accounts'; accountId: string }
  | {
      type: 'id-registration:apple-request';
      page: '/';
      requestId: string;
      action: AppleMailboxBridgeAction;
      payload: Record<string, unknown>;
    };

export type AppleMailboxBridgeAction =
  | 'candidates'
  | 'start'
  | 'batch'
  | 'task'
  | 'batch-status'
  | 'cancel-task'
  | 'cancel-batch';

export interface AutoRegistrationParentState {
  type: 'id-registration:state';
  theme: 'light' | 'dark';
  tokens: Record<string, string>;
  draft: AutoRegistrationDraft;
}
