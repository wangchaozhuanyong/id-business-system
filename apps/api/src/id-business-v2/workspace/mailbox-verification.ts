import type { V2VendureMailboxAlias } from '@apple-business/shared';
import { ConflictException } from '@nestjs/common';

export function assertMailboxEmail(email: string, expectedEmail?: string) {
  if (
    expectedEmail !== undefined &&
    email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()
  )
    throw new ConflictException('隐藏邮箱地址已变化，请核对原邮箱');
}

export function mailboxAuthorizationValid(
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
