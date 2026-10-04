import type { PaginatedResult } from './common.js';

export function isV2MailboxVerificationCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{4,8}$/i.test(value) && /\d/.test(value);
}

export function resolveV2MailboxVerificationCode(mail: {
  extractedCode?: string | null;
  subject: string;
  bodyText?: string | null;
}): string | null {
  const extracted = typeof mail.extractedCode === 'string' ? mail.extractedCode.trim() : '';
  if (isV2MailboxVerificationCode(extracted)) return extracted;

  // 仅回退同封邮件中的明确数字验证码，不另建上游的通用邮件提取器。
  const candidates = new Set<string>();
  const body = mail.bodyText ?? '';
  function addCandidate(text: string, match: RegExpExecArray, minimumDigits: number) {
    const value = match[1]!;
    if (!/^\d{4,8}$/.test(value) || value.length < minimumDigits) return;
    const start = match.index + match[0].lastIndexOf(value);
    const end = start + value.length;
    // 所有候选统一校验完整内容与两侧分组，不能截取邮箱、连字符或跨行数字。
    if (
      /\d(?:\s+|\s*[-–—]\s*)$/.test(text.slice(0, start)) ||
      /^(?:\s+|\s*[-–—]\s*)\d/.test(text.slice(end))
    )
      return;
    candidates.add(value);
  }
  for (const text of [mail.subject, body]) {
    for (const match of text.matchAll(
      /(?:验证码|\b(?:verification|security|temporary|one[- ]time|login)[\t ]+code\b|\bOTP\b)[\t ]*[:：]?[\t ]*(?:\r?\n[\t ]*)?(\S+)/gi
    )) {
      addCandidate(text, match, 4);
    }
  }
  if (/\bChatGPT\b/i.test(mail.subject) && /verification\s+code/i.test(mail.subject)) {
    for (const match of body.matchAll(/^[\t ]*(\S+)[\t ]*\r?$/gm)) {
      addCandidate(body, match, 6);
    }
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function normalizeV2MailboxVerificationMail<
  T extends { extractedCode?: string | null; subject: string; bodyText?: string | null }
>(mail: T): T & { extractedCode: string | null } {
  return { ...mail, extractedCode: resolveV2MailboxVerificationCode(mail) };
}

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
