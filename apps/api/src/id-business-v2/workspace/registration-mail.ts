import type { V2VendureMailboxPublicMail } from '@apple-business/shared';

function recipientMatches(
  mail: V2VendureMailboxPublicMail,
  email: string,
  authorizedAliasId?: string
) {
  if (authorizedAliasId && mail.virtualEmailId !== authorizedAliasId) return false;
  const recipient = mail.targetEmail?.toLowerCase();
  const expected = email.toLowerCase();
  if (recipient === expected) return true;
  // The public mailbox endpoint masks addresses. Only the alias revalidated
  // through the authenticated admin lookup can identify a masked recipient.
  if (!authorizedAliasId || !recipient) return false;
  const maskedParts = recipient.split('@');
  const expectedParts = expected.split('@');
  if (maskedParts.length !== 2 || expectedParts.length !== 2 || maskedParts[1] !== expectedParts[1])
    return false;
  const mask = /^([^*\s@]+)\*+([^*\s@]*)$/.exec(maskedParts[0]!);
  if (!mask) return false;
  const [, prefix, suffix] = mask;
  const local = expectedParts[0]!;
  return (
    local.length > prefix!.length + suffix!.length &&
    local.startsWith(prefix!) &&
    local.endsWith(suffix!)
  );
}

function officialSender(address: string) {
  const parts = address.trim().toLowerCase().split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (domain === 'openai.com' || domain?.endsWith('.openai.com')) return true;
  // Compatibility hint for encoded Hide My Email senders, not original-domain authentication.
  // Recipient, time and previously consumed mail constraints still apply.
  return (
    domain === 'icloud.com' &&
    /^[a-z0-9]+_at_(?:[a-z0-9]+_)*openai_com_[a-z0-9_]+$/.test(local ?? '')
  );
}

function numericCode(mail: V2VendureMailboxPublicMail) {
  if (/^\d{6,8}$/.test(mail.extractedCode ?? '')) return mail.extractedCode!;
  const candidates = new Set<string>();
  for (const content of [mail.subject, mail.bodyText ?? '']) {
    for (const match of content.matchAll(
      /(?:\b(?:verification|security|login|one-time|ChatGPT)[\t ]+code\b|验证码|校验码|登录代码|登录码)[\t :：]*(?:is[\t ]+|[为是][\t ]*)?(?:\r?\n[\t ]*)?(\S+)/gi
    )) {
      const token = match[1]!;
      const value = token.replace(/[.。,，!！?？;；]$/, '');
      if (!/^\d{6,8}$/.test(value)) continue;
      const start = match.index + match[0].lastIndexOf(token);
      const end = start + value.length;
      if (
        /\d(?:\s+|\s*[-–—]\s*)$/.test(content.slice(0, start)) ||
        /^(?:\s+|\s*[-–—]\s*)\d/.test(content.slice(end))
      )
        continue;
      candidates.add(value);
    }
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

export function registrationMail(
  items: V2VendureMailboxPublicMail[],
  email: string,
  since: Date,
  previousId: string | null,
  authorizedAliasId?: string
) {
  const previous = items.find(
    (mail) => mail.id === previousId && recipientMatches(mail, email, authorizedAliasId)
  );
  const previousReceived = previous ? Date.parse(previous.receivedAt) : NaN;
  const candidates = items
    .filter((mail) => {
      const received = Date.parse(mail.receivedAt);
      return (
        mail.id !== previousId &&
        recipientMatches(mail, email, authorizedAliasId) &&
        officialSender(mail.fromAddress) &&
        Number.isFinite(received) &&
        received >= since.getTime() &&
        (!Number.isFinite(previousReceived) || received > previousReceived) &&
        received <= Date.now() + 60_000 &&
        /verification|verify|code|password|security|验证码|校验码|登录代码|登录码|密码|验证/i.test(
          mail.subject
        )
      );
    })
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  for (const mail of candidates) {
    const code = numericCode(mail);
    if (code) return { mailId: mail.id, code };
    for (const raw of (mail.bodyText ?? '').match(/https:\/\/[^\s<>"']+/g) ?? []) {
      try {
        const url = new URL(raw.replace(/&amp;/g, '&'));
        if (
          url.protocol === 'https:' &&
          (!url.port || url.port === '443') &&
          ['auth.openai.com', 'auth0.openai.com'].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          /password|verify|email|confirmation/i.test(url.pathname)
        )
          return { mailId: mail.id, code: url.href };
      } catch {
        /* 不使用无法解析的邮件链接。 */
      }
    }
  }
  return null;
}
