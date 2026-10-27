export const mailboxQueryCodeValidityOptions = [
  { days: 30, label: '30天' },
  { days: 90, label: '3个月（90天）' },
  { days: 180, label: '半年（180天）' },
  { days: 365, label: '1年（365天）' }
] as const;

export interface MailboxQueryCodeResetTarget {
  key: string;
  email: string;
  expiresAt: string | null;
  validityDays: number;
}

export interface MailboxQueryCodeResetResult {
  queryCode: string;
  expiresAt: string | null;
}

export function previewMailboxQueryCodeExpiry(issuedAt: number, days: number): string | null {
  return days > 0 ? new Date(issuedAt + days * 86_400_000).toISOString() : null;
}
