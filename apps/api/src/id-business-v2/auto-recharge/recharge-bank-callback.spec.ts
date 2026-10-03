import { describe, expect, it } from 'vitest';
import { mergeRechargeCallbackResult } from './recharge-bank-callback';
import { safeDocument } from './recharge-validation';

describe('充值邮箱元数据与银行认证回执', () => {
  it('执行器不能伪造邮件读码状态，进度合并保留服务端已授权的状态', () => {
    const metadata = {
      login_mail_requested_at: '2026-10-03T01:00:00.000Z',
      login_mail_alias_id: 'synthetic-alias',
      login_mail_offered_id: 'synthetic-mail',
      login_mail_received_id: 'synthetic-mail'
    };
    expect(safeDocument(metadata)).toEqual({});
    const merged = mergeRechargeCallbackResult(
      { result: { ...metadata, stage: 'login_email_code_required' } } as never,
      safeDocument({ stage: 'login_email_code_submitted', ...metadata })
    );
    expect(merged).toMatchObject({ ...metadata, stage: 'login_email_code_submitted' });
  });

  it('只记录受控银行验证状态，不保存挑战地址或密钥', () => {
    for (const status of [
      'not_required',
      'authenticating',
      'awaiting_user',
      'completed',
      'failed',
      'unsupported'
    ])
      expect(
        safeDocument({
          three_ds_status: status,
          challenge_url: 'https://example.test/private',
          client_secret: 'private'
        })
      ).toEqual({ three_ds_status: status });
    expect(safeDocument({ three_ds_status: 'other' })).toEqual({});
  });

  it('账期仅接受同协议的ISO时间、账号摘要与目标套餐', () => {
    const period = {
      source: 'official_subscription_response',
      start: '2026-10-03T01:00:00.000Z',
      end: '2026-11-03T01:00:00.000Z',
      account_key: 'a'.repeat(64),
      target_plan: 'pro-5x'
    };
    expect(safeDocument({ subscription_period: period })).toEqual({ subscription_period: period });
    for (const invalid of [
      { ...period, start: period.end },
      { ...period, end: '2026-11-31T01:00:00.000Z' },
      { ...period, source: 'internal_default' },
      { ...period, account_key: 'raw-email' },
      { ...period, token: 'private' }
    ])
      expect(safeDocument({ subscription_period: invalid })).toEqual({});
  });
});
