import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  appleMailboxBrowserPhaseLabel,
  appleMailboxDiagnostic
} from './apple-mailbox-presentation';
import type { AppleMailboxBrowserRegistration } from './contracts';

describe('浏览器注册进度中文展示', () => {
  it('API与页面使用同一闭合浏览器状态类型', () => {
    const sources = [
      new URL('./contracts.ts', import.meta.url),
      new URL(
        '../../../../../../apps/api/src/id-business-v2/auto-registration/apple-mailboxes.types.ts',
        import.meta.url
      )
    ].map((file) => readFileSync(file, 'utf8'));
    const block = (source: string) =>
      source.match(/export interface AppleMailboxBrowserRegistration \{[\s\S]*?\n\}/)?.[0];
    expect(block(sources[0]!)).toBeTruthy();
    expect(block(sources[0]!)).toBe(block(sources[1]!));
  });
  it.each([
    ['waiting_for_browser', '等待助手接收'],
    ['claimed', '助手已接管'],
    ['browser_opened', '窗口已打开'],
    ['email_submitting', '注册邮箱'],
    ['password_submitting', '账号密码'],
    ['email_code_required', '邮箱验证码'],
    ['profile_required', '补齐官网要求的资料'],
    ['human_verification_required', '本人完成官网验证'],
    ['official_identity_observed', '官网账号身份'],
    ['identity_verifying', '服务端正在核验'],
    ['completed', '保存和同步以上方记录为准'],
    ['failed', '核对原任务'],
    ['cancelled', '已取消'],
    ['expired', '已到期'],
    ['interrupted', '已中断']
  ])('%s 映射明确中文，不把浏览器阶段当成主台账成功', (phase, label) => {
    expect(
      appleMailboxBrowserPhaseLabel({ phase, needAction: false } as AppleMailboxBrowserRegistration)
    ).toContain(label);
  });
  it('旧任务兼容，未知值不直接渲染内部枚举或不可信原文', () => {
    expect(appleMailboxBrowserPhaseLabel()).toBe('');
    const value = appleMailboxBrowserPhaseLabel({
      phase: 'synthetic-private-unknown',
      needAction: true
    } as unknown as AppleMailboxBrowserRegistration);
    expect(value).toContain('待核对');
    expect(value).not.toContain('synthetic-private-unknown');
    expect(appleMailboxDiagnostic({ stage: 'manual_verification' })).toContain('本人完成官网验证');
  });
});
