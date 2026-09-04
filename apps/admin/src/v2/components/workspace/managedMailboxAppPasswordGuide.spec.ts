import { describe, expect, it } from 'vitest';
import {
  resolveManagedMailboxAppPasswordGuide,
  resolveManagedMailboxAppPasswordGuideLinks
} from './managedMailboxAppPasswordGuide';

describe('managed mailbox app-password guides', () => {
  it('links Gmail users to the official password manager and Chinese instructions', () => {
    expect(resolveManagedMailboxAppPasswordGuide('gmail')).toEqual({
      accountLabel: '前往 Google 生成',
      accountUrl: 'https://myaccount.google.com/apppasswords',
      help: '需先开启 Google 两步验证；密码仅在生成时显示一次，不要填写 Gmail 普通登录密码。',
      supportUrl: 'https://support.google.com/accounts/answer/185833?hl=zh-Hans'
    });
  });

  it('links iCloud users to Apple account management and official instructions', () => {
    expect(resolveManagedMailboxAppPasswordGuide('icloud')).toEqual({
      accountLabel: '登录 Apple 账户生成',
      accountUrl: 'https://account.apple.com/',
      help: '需先开启 Apple 双重认证；登录后进入“登录和安全 → App 专用密码”生成。',
      supportUrl: 'https://support.apple.com/zh-cn/102654'
    });
  });

  it('does not show an app-password guide for Microsoft OAuth2 mailboxes', () => {
    expect(resolveManagedMailboxAppPasswordGuide('microsoft')).toBeNull();
    expect(resolveManagedMailboxAppPasswordGuideLinks('microsoft')).toEqual([]);
  });

  it('provides account and official-instruction actions for the help popover', () => {
    expect(resolveManagedMailboxAppPasswordGuideLinks('gmail')).toEqual([
      {
        href: 'https://myaccount.google.com/apppasswords',
        label: '前往 Google 生成'
      },
      {
        href: 'https://support.google.com/accounts/answer/185833?hl=zh-Hans',
        label: '查看官方步骤'
      }
    ]);
  });
});
