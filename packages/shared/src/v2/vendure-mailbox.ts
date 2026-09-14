import type { PaginatedResult } from './common.js';

export type V2VendureMailboxPrimaryStatus = 'ACTIVE' | 'DISABLED' | 'AUTH_ERROR' | 'SYNCING';
export type V2VendureMailboxAliasStatus = 'ACTIVE' | 'DISABLED';

export interface V2VendureMailboxPrimaryAccount {
  id: string;
  createdAt: string;
  updatedAt: string;
  email: string;
  note: string | null;
  status: V2VendureMailboxPrimaryStatus;
  imapHost: string;
  imapPort: number;
  masterQueryCode: string | null;
  codeExpiresAt: string | null;
  codeResetIntervalDays: number;
  remainingDays: number | null;
  lastQueriedAt: string | null;
  lastQueriedIp: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  virtualEmailCount: number;
}

export interface V2VendureMailboxAlias {
  id: string;
  createdAt: string;
  updatedAt: string;
  primaryAccountId: string;
  primaryAccountEmail: string | null;
  aliasEmail: string;
  note: string | null;
  status: V2VendureMailboxAliasStatus;
  buyerQueryCode: string;
  codeExpiresAt: string | null;
  codeResetIntervalDays: number;
  remainingDays: number | null;
  lastQueriedAt: string | null;
  lastQueriedIp: string | null;
  mailCount: number;
  lastMailReceivedAt: string | null;
}

export interface V2VendureMailboxMail {
  id: string;
  createdAt: string;
  updatedAt: string;
  primaryAccountId: string;
  virtualEmailId: string | null;
  messageId: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  bodyText: string | null;
  extractedCode: string | null;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
}

export interface V2VendureMailboxStatus {
  configured: boolean;
  connected: boolean;
  message: string | null;
}

export type V2VendureMailboxPage<T> = PaginatedResult<T>;

export interface V2VendureMailboxListQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
  primaryAccountId?: string;
  virtualEmailId?: string;
  unassignedOnly?: boolean;
}

export interface CreateV2VendureMailboxPrimaryInput {
  email: string;
  appPassword: string;
  note?: string;
  imapHost?: string;
  imapPort?: number;
  codeResetIntervalDays?: number;
  masterQueryCode?: string;
}

export interface UpdateV2VendureMailboxPrimaryInput {
  email?: string;
  appPassword?: string;
  note?: string;
  status?: V2VendureMailboxPrimaryStatus;
  imapHost?: string;
  imapPort?: number;
  codeResetIntervalDays?: number;
  masterQueryCode?: string;
}

export interface CreateV2VendureMailboxAliasInput {
  primaryAccountId: string;
  aliasEmail: string;
  note?: string;
  buyerQueryCode?: string;
  codeResetIntervalDays?: number;
}

export interface BatchCreateV2VendureMailboxAliasesInput {
  primaryAccountId: string;
  rawInput: string;
  codeResetIntervalDays?: number;
}

export interface UpdateV2VendureMailboxAliasInput {
  aliasEmail?: string;
  note?: string;
  status?: V2VendureMailboxAliasStatus;
  buyerQueryCode?: string;
  codeResetIntervalDays?: number;
}

export interface V2VendureMailboxBatchResult {
  createdCount: number;
  skippedCount: number;
  errors: string[];
}

export interface V2VendureMailboxConnectionResult {
  success: boolean;
  message: string;
}

export interface V2VendureMailboxSyncResult {
  success: boolean;
  syncedCount: number;
  error: string | null;
}

export interface V2VendureMailboxHistoryResult {
  scannedCount: number;
  matchedCount: number;
  updatedCount: number;
  unmatchedCount: number;
  ambiguousCount: number;
  unresolvedCount: number;
  skippedCount: number;
}

export interface V2VendureMailboxPublicMail {
  id: string;
  virtualEmailId: string | null;
  fromAddress: string;
  fromName: string;
  subject: string;
  receivedAt: string;
  extractedCode: string | null;
  bodyText: string | null;
  targetEmail: string;
}

export interface V2VendureMailboxPublicQueryResult {
  success: boolean;
  message: string | null;
  targetType: string | null;
  aliasEmail: string | null;
  primaryEmail: string | null;
  codeExpiresAt: string | null;
  remainingDays: number | null;
  totalEmails: number;
  items: V2VendureMailboxPublicMail[];
  virtualEmailsList: Array<{ id: string; aliasEmail: string; note: string | null }> | null;
}
