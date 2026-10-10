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
  { path: '/accounts', title: '账号管理' },
  { path: '/email-services', title: '邮箱服务' },
  { path: '/payment', title: '订阅管理' },
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
  | 'interrupted';
export type AppleMailboxResultKind = 'new_registration' | 'existing_account' | 'failed' | null;

export interface AppleMailboxRecord {
  revision: number;
  registrationStatus: AppleMailboxRegistrationStatus;
  registrationIp: string | null;
  registrationIpSource: 'manual' | 'observed' | null;
  source: 'manual' | 'automatic' | null;
  note: string | null;
  markedAt: string | null;
  operatorId: string | null;
  activeTaskUuid: string | null;
  lastTaskUuid: string | null;
  lastResultKind: AppleMailboxResultKind;
  taskStatus: AppleMailboxTaskStatus | null;
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
  registrationIpSource: 'manual' | 'observed' | null;
  note: string | null;
  source: 'manual' | 'automatic' | null;
  updatedAt: string | null;
  revision: number;
  taskUuid: string | null;
  taskStatus: AppleMailboxTaskStatus | null;
  canRegister: boolean;
  blockedReason: string | null;
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
export interface AppleMailboxMarkInput {
  items: AppleMailboxTarget[];
  registrationStatus: AppleMailboxRegistrationStatus;
  registrationIp: string | null;
  note: string;
}
export interface AppleMailboxTask {
  taskUuid: string;
  status: AppleMailboxTaskStatus;
  logs: string[];
  record: AppleMailboxRecord;
  resultKind: AppleMailboxResultKind;
}
export type AutoRegistrationDraft = Record<string, string | boolean>;

export type AutoRegistrationChildMessage =
  | { type: 'id-registration:ready'; page: AutoRegistrationPage }
  | { type: 'id-registration:draft'; page: AutoRegistrationPage; values: unknown };

export interface AutoRegistrationParentState {
  type: 'id-registration:state';
  theme: 'light' | 'dark';
  tokens: Record<string, string>;
  draft: AutoRegistrationDraft;
}
