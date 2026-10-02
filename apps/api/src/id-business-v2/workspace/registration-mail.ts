import type { V2VendureMailboxPublicMail } from '@apple-business/shared';

export function registrationMail(
  items: V2VendureMailboxPublicMail[],
  email: string,
  since: Date,
  previousId: string | null
) {
  const candidates = items
    .filter((mail) => {
      const sender = mail.fromAddress.trim().toLowerCase().split('@').pop() ?? '';
      const received = Date.parse(mail.receivedAt);
      return (
        mail.id !== previousId &&
        mail.targetEmail?.toLowerCase() === email.toLowerCase() &&
        (sender === 'openai.com' || sender.endsWith('.openai.com')) &&
        Number.isFinite(received) &&
        received >= since.getTime() &&
        received <= Date.now() + 60_000 &&
        /verification|verify|code|password|security|验证码|密码|验证/i.test(mail.subject)
      );
    })
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  for (const mail of candidates) {
    if (mail.extractedCode && /^\d{6,8}$/.test(mail.extractedCode))
      return { mailId: mail.id, code: mail.extractedCode };
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
