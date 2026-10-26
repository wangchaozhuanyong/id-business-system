import type { V2MailProvider } from '@apple-business/shared';

const PROVIDERS: Record<string, V2MailProvider> = {
  'outlook.com': 'microsoft',
  'hotmail.com': 'microsoft',
  'live.com': 'microsoft',
  'msn.com': 'microsoft',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail'
};

/** Select a mail service, never infer ownership or grant access from the address. */
export function detectManagedMailboxProvider(email: string): V2MailProvider | undefined {
  const domain = /^[^\s@]+@([a-z0-9.-]+)$/i.exec(email.trim())?.[1]?.toLowerCase();
  return domain && Object.hasOwn(PROVIDERS, domain) ? PROVIDERS[domain] : undefined;
}

/** Only switch bare-address batches: password columns must never become OAuth remarks. */
export function detectManagedMailboxBatchProvider(
  sources: readonly string[]
): V2MailProvider | undefined {
  if (!sources.length || sources.some((source) => source.includes('----'))) return undefined;
  const provider = detectManagedMailboxProvider(sources[0] ?? '');
  return provider && sources.every((source) => detectManagedMailboxProvider(source) === provider)
    ? provider
    : undefined;
}
