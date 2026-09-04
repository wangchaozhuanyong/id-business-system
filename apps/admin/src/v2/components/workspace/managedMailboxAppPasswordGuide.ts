import type { V2MailProvider } from '@apple-business/shared';

export interface V2ManagedMailboxAppPasswordGuide {
  accountLabel: string;
  accountUrl: string;
  help: string;
  supportUrl: string;
}

export interface V2ManagedMailboxAppPasswordGuideLink {
  href: string;
  label: string;
}

const APP_PASSWORD_GUIDES = {
  gmail: {
    accountLabel: '前往 Google 生成',
    accountUrl: 'https://myaccount.google.com/apppasswords',
    help: '需先开启 Google 两步验证；密码仅在生成时显示一次，不要填写 Gmail 普通登录密码。',
    supportUrl: 'https://support.google.com/accounts/answer/185833?hl=zh-Hans'
  },
  icloud: {
    accountLabel: '登录 Apple 账户生成',
    accountUrl: 'https://account.apple.com/',
    help: '需先开启 Apple 双重认证；登录后进入“登录和安全 → App 专用密码”生成。',
    supportUrl: 'https://support.apple.com/zh-cn/102654'
  }
} as const satisfies Record<Exclude<V2MailProvider, 'microsoft'>, V2ManagedMailboxAppPasswordGuide>;

export function resolveManagedMailboxAppPasswordGuide(
  provider: V2MailProvider
): V2ManagedMailboxAppPasswordGuide | null {
  if (provider === 'microsoft') return null;
  return APP_PASSWORD_GUIDES[provider];
}

export function resolveManagedMailboxAppPasswordGuideLinks(
  provider: V2MailProvider
): V2ManagedMailboxAppPasswordGuideLink[] {
  const guide = resolveManagedMailboxAppPasswordGuide(provider);
  if (!guide) return [];
  return [
    { href: guide.accountUrl, label: guide.accountLabel },
    { href: guide.supportUrl, label: '查看官方步骤' }
  ];
}
