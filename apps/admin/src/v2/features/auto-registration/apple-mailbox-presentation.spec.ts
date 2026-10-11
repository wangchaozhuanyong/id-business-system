import { describe, expect, it } from 'vitest';
import { isAutoRegistrationPage } from './bridge';
import { appleMailboxPage, type AppleMailboxRow } from './contracts';
import {
  appleMailboxIpSourceLabel,
  appleMailboxMarkError,
  appleMailboxRegisterReason,
  appleMailboxSourceLabel,
  appleMailboxStatusLabel,
  appleMailboxTaskLabel,
  isAppleMailboxIp,
  appleMailboxSyncLabel,
  appleMailboxCanSync,
  appleMailboxDiagnostic,
  appleMailboxSelectionLabel,
  appleMailboxCanSaveLocal
} from './apple-mailbox-presentation';

const row: AppleMailboxRow = {
  aliasId: 'alias-1',
  email: 'hidden@example.invalid',
  primaryEmail: 'primary@example.invalid',
  mailboxStatus: 'ACTIVE',
  authorizationValid: true,
  primaryAvailable: true,
  registrationStatus: 'unregistered',
  registrationIp: null,
  registrationIpSource: null,
  note: null,
  source: 'manual',
  updatedAt: null,
  revision: 1,
  taskUuid: null,
  taskStatus: null,
  canRegister: true,
  blockedReason: null
};

describe('苹果隐藏邮箱注册边界与中文展示', () => {
  it('显示首次失败快照，不把前序成功或当前同步步骤当成失败位置', () => {
    const text = appleMailboxDiagnostic({
      stage: 'sync',
      reason: 'identity_missing',
      firstFailure: {
        stage: 'create_account',
        errorKind: 'account_creation_failed',
        httpStatus: 400,
        elapsedMs: 1500,
        observedAt: '2026-10-11T00:00:00Z'
      }
    });
    expect(text).toContain('首次失败：创建官网账号');
    expect(text).toContain('响应状态 400');
    expect(text).toContain('耗时 1.5 秒');
    expect(text).toContain('当前：ChatGPT 账号同步');
    expect(text).not.toContain('account_creation_failed');
  });
  it('授权网络异常明确没有响应状态，工作区步骤中文显示', () => {
    const text = appleMailboxDiagnostic({
      firstFailure: {
        stage: 'select_workspace',
        errorKind: 'network_error',
        httpStatus: null,
        elapsedMs: 0,
        observedAt: '2026-10-11T00:00:00Z'
      }
    });
    expect(text).toContain('首次失败：选择账号工作区');
    expect(text).toContain('未取得响应状态');
    expect(text).not.toContain('200');
    expect(appleMailboxDiagnostic({ stage: 'redirect' })).toBe('授权跳转');
  });
  it('选择来源仅显示安全的代理目录编号，旧记录不补造来源', () => {
    expect(
      appleMailboxSelectionLabel({
        mailboxSelection: 'automatic',
        proxySource: 'system',
        proxyId: 'proxy-1'
      })
    ).toBe('自动选择邮箱 · 系统代理（编号 proxy-1）');
    expect(
      appleMailboxSelectionLabel({
        mailboxSelection: 'specified',
        proxySource: 'default',
        proxyId: null
      })
    ).toBe('指定邮箱 · 系统默认代理配置');
    expect(appleMailboxSelectionLabel({})).toBe('');
  });
  it('同步和注册事实独立，待身份核验不显示成功或自动重注册入口', () => {
    expect(appleMailboxSyncLabel('saved')).toContain('已同步');
    expect(appleMailboxSyncLabel('awaiting_identity')).toBe('等待身份核验');
    expect(appleMailboxSyncLabel('quarantined')).toContain('隔离');
    expect(appleMailboxCanSync('awaiting_identity')).toBe(true);
    expect(appleMailboxCanSync('conflict')).toBe(false);
    expect(appleMailboxCanSync('saved')).toBe(false);
    expect(appleMailboxCanSync('failed')).toBe(true);
    expect(appleMailboxCanSaveLocal('failed', 'running')).toBe(false);
    expect(appleMailboxCanSaveLocal('failed', 'failed')).toBe(true);
    expect(
      appleMailboxDiagnostic({ stage: 'create_account', reason: 'account_creation_failed' })
    ).toContain('官网返回账号创建失败');
    expect(
      appleMailboxDiagnostic({ stage: 'identity', reason: 'existing_account_suspected' })
    ).toContain('等待身份核验');
  });
  it('自有页签不加入上游 iframe 页面白名单', () => {
    expect(appleMailboxPage.title).toBe('苹果隐藏邮箱');
    expect(isAutoRegistrationPage(appleMailboxPage.path)).toBe(false);
  });
  it('仅允许已确认未注册、可用、未占用且服务器允许的邮箱注册', () => {
    expect(appleMailboxRegisterReason(row)).toBe('');
    for (const patch of [
      { registrationStatus: 'unknown' },
      { registrationStatus: 'registered' },
      { mailboxStatus: 'DISABLED' },
      { authorizationValid: false },
      { primaryAvailable: false },
      { taskStatus: 'pending' },
      { taskStatus: 'running' },
      { taskStatus: 'interrupted' },
      { canRegister: false }
    ])
      expect(appleMailboxRegisterReason({ ...row, ...patch } as AppleMailboxRow)).not.toBe('');
    expect(
      appleMailboxRegisterReason({ ...row, canRegister: false, blockedReason: '后台任务已占用' })
    ).toBe('后台任务已占用');
  });
  it.each([
    '',
    '0.0.0.0',
    '203.0.113.10',
    '255.255.255.255',
    '::1',
    '2001:db8::1',
    '::ffff:192.0.2.1'
  ])('允许空值及合法 IP：%s', (value) => expect(isAppleMailboxIp(value)).toBe(true));
  it.each([
    'example.com',
    '01.2.3.4',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4:80',
    '2001:::1',
    'fe80::1%en0',
    'http://203.0.113.10',
    '<script>'
  ])('拒绝无效 IP 或非 IP 地址：%s', (value) => expect(isAppleMailboxIp(value)).toBe(false));
  it('人工历史标记允许未知 IP，拒绝空选择和超长备注', () => {
    const input = {
      items: [{ aliasId: row.aliasId, revision: row.revision }],
      registrationStatus: 'registered' as const,
      registrationIp: null,
      note: ''
    };
    expect(appleMailboxMarkError(input)).toBe('');
    expect(appleMailboxMarkError({ ...input, items: [] })).toContain('请选择');
    expect(appleMailboxMarkError({ ...input, registrationIp: 'invalid' })).toContain('IPv4');
    expect(appleMailboxMarkError({ ...input, note: '字'.repeat(501) })).toContain('500');
  });
  it('所有状态、标记来源和 IP 证据均映射中文', () => {
    expect(appleMailboxStatusLabel('unknown')).toBe('待确认');
    expect(appleMailboxStatusLabel('registered')).toBe('已注册');
    expect(appleMailboxTaskLabel('interrupted')).toBe('中断待核对');
    expect(appleMailboxTaskLabel(null)).toBe('暂无任务');
    expect(appleMailboxSourceLabel(null)).toBe('未标记');
    expect(appleMailboxSourceLabel('manual')).toBe('人工标记');
    expect(appleMailboxSourceLabel('automatic')).toBe('注册任务');
    expect(appleMailboxIpSourceLabel('observed')).toBe('任务检测出口');
    expect(appleMailboxIpSourceLabel('manual')).toBe('人工填写');
  });
});
