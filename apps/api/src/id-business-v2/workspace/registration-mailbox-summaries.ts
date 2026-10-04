import type { V2VendureMailboxAlias, V2VendureMailboxPrimaryAccount } from '@apple-business/shared';
import { ConflictException } from '@nestjs/common';
import type { IdBusinessV2VendureMailboxClient } from './providers/id-business-v2-vendure-mailbox.client';

export async function loadRegistrationMailboxSummaries(
  client: Pick<IdBusinessV2VendureMailboxClient, 'virtualEmails' | 'primaryAccounts'>
) {
  const [aliases, primaries] = await Promise.all([
    client.virtualEmails(),
    client.primaryAccounts()
  ]);
  return summarizeRegistrationMailboxes(aliases, primaries);
}

export function assertRegistrationMailboxEmail(email: string, expectedEmail?: string) {
  if (
    expectedEmail !== undefined &&
    email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()
  )
    throw new ConflictException('隐藏邮箱地址已变化，请核对原注册任务');
}

export function registrationMailboxAuthorizationValid(
  mailbox: Pick<V2VendureMailboxAlias, 'buyerQueryCode' | 'codeExpiresAt'>,
  now = Date.now()
) {
  return (
    Boolean(mailbox.buyerQueryCode) &&
    (!mailbox.codeExpiresAt ||
      (Number.isFinite(Date.parse(mailbox.codeExpiresAt)) &&
        Date.parse(mailbox.codeExpiresAt) > now))
  );
}

export function summarizeRegistrationMailboxes(
  aliases: V2VendureMailboxAlias[],
  primaries: V2VendureMailboxPrimaryAccount[],
  now = Date.now()
) {
  const availablePrimaryIds = new Set(
    primaries.filter((item) => item.status === 'ACTIVE').map((item) => item.id)
  );
  return aliases.map((item) => ({
    id: item.id,
    email: item.aliasEmail,
    primaryEmail: item.primaryAccountEmail,
    status: item.status,
    note: item.note,
    updatedAt: item.updatedAt,
    authorizationValid: registrationMailboxAuthorizationValid(item, now),
    primaryAvailable: availablePrimaryIds.has(item.primaryAccountId)
  }));
}
