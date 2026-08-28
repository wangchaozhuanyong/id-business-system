import type { IsoDateTimeString } from './common.js';

export const V2_WORKSPACE_SHORTCUT_LIMITS = {
  count: 20,
  name: 60,
  url: 2048
} as const;

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

export const V2_MAIL_PROVIDERS = ['gmail', 'icloud'] as const;
export const V2_MANAGED_MAILBOX_STATUSES = ['active', 'disabled', 'auth_failed'] as const;

export type V2MailProvider = (typeof V2_MAIL_PROVIDERS)[number];
export type V2ManagedMailboxStatus = (typeof V2_MANAGED_MAILBOX_STATUSES)[number];

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

export interface V2MailViewerQueryInput {
  credential: string;
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

export interface CreateV2ManagedMailboxInput {
  email: string;
  provider: V2MailProvider;
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
