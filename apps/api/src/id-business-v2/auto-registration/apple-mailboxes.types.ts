export type AppleMailboxRegistrationStatus = 'unknown' | 'unregistered' | 'registered';
export type AppleMailboxSyncStatus =
  | 'not_ready'
  | 'not_started'
  | 'pending'
  | 'syncing'
  | 'saved'
  | 'failed'
  | 'conflict'
  | 'awaiting_identity'
  | 'blocked'
  | 'quarantined';
export type AppleMailboxLocalSaveStatus =
  | 'not_ready'
  | 'not_started'
  | 'pending'
  | 'saved'
  | 'failed';
export type AppleMailboxTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'awaiting_review';

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
  email: string;
  aliasId: string | null;
  registrationStatus: AppleMailboxRegistrationStatus;
  revision: number;
  registrationIp: string | null;
  registrationIpSource: 'manual' | 'observed' | null;
  source: 'manual' | 'automatic' | 'account_history' | null;
  markedAt: string | null;
  operatorId: string | null;
  note: string;
  activeTaskUuid: string | null;
  attemptIp: string | null;
  attemptCountry: string | null;
  registrationCountry: string | null;
  lastTaskUuid: string | null;
  lastResultKind: 'new_registration' | 'existing_account' | 'failed' | null;
  taskStatus: AppleMailboxTaskStatus | null;
  localSaveStatus?: AppleMailboxLocalSaveStatus;
  syncStatus?: AppleMailboxSyncStatus;
  systemAccountId?: string | null;
  errorKind?: string | null;
  syncErrorKind?: string | null;
  identityStatus?: 'not_checked' | 'not_verified' | 'awaiting_identity' | 'verified' | 'mismatch';
  passwordStatus?:
    | 'not_submitted'
    | 'not_started'
    | 'checkpointed'
    | 'saved'
    | 'submitted'
    | 'unknown';
  stage?: AppleMailboxRegistrationStage;
  reason?: string | null;
  lastHttpStatus?: number | null;
  proxySource?: 'system' | 'explicit' | 'default';
  proxyId?: string | null;
  mailboxSelection?: 'specified' | 'automatic';
  firstFailure?: AppleMailboxFailure | null;
}

export interface AppleMailboxTask {
  taskUuid: string;
  status: AppleMailboxTaskStatus;
  logs: string[];
  record: AppleMailboxRecord;
  resultKind: AppleMailboxRecord['lastResultKind'];
}

export interface AppleMailboxSummary {
  id: string;
  email: string;
  primaryEmail: string | null;
  status: string;
  note: string | null;
  updatedAt: string;
  authorizationValid: boolean;
  primaryAvailable: boolean;
}

export interface AppleMailboxRow {
  aliasId: string;
  email: string;
  primaryEmail: string | null;
  mailboxStatus: string;
  authorizationValid: boolean;
  primaryAvailable: boolean;
  registrationStatus: AppleMailboxRegistrationStatus;
  registrationIp: string | null;
  registrationIpSource: AppleMailboxRecord['registrationIpSource'];
  source: AppleMailboxRecord['source'];
  note: string | null;
  updatedAt: string;
  revision: number;
  taskUuid: string | null;
  taskStatus: AppleMailboxTaskStatus | null;
  canRegister: boolean;
  blockedReason: string | null;
  localSaveStatus?: AppleMailboxLocalSaveStatus;
  syncStatus?: AppleMailboxSyncStatus;
  systemAccountId?: string | null;
  errorKind?: string | null;
  syncErrorKind?: string | null;
  identityStatus?: AppleMailboxRecord['identityStatus'];
  passwordStatus?: AppleMailboxRecord['passwordStatus'];
  stage?: AppleMailboxRecord['stage'];
  reason?: string | null;
  lastHttpStatus?: number | null;
  proxySource?: AppleMailboxRecord['proxySource'];
  proxyId?: AppleMailboxRecord['proxyId'];
  mailboxSelection?: AppleMailboxRecord['mailboxSelection'];
  firstFailure?: AppleMailboxRecord['firstFailure'];
}

export interface AppleMailboxBatch {
  batchId: string;
  taskUuids: string[];
  records: AppleMailboxRecord[];
  skipped: { aliasId: string; reason: string }[];
  accepted: number;
  requested: number;
  status?: AppleMailboxTaskStatus;
  tasks?: AppleMailboxTask[];
}

/** Private worker response: never return credentials to the browser. */
export interface AppleMailboxSyncPayload {
  accountId: string;
  sourceTaskUuid: string;
  upstreamAccountId: string | number;
  operatorId: string;
  aliasId: string;
  email: string;
  password?: string | null;
  registrationCountry: string | null;
  source: 'register' | 'login';
  fingerprint: string;
}

export interface AppleMailboxCodeRequest {
  id: string;
  taskUuid: string;
  aliasId: string;
  email: string;
  since: string;
  previousId: string | null;
}
