import { describe, expect, it, vi } from 'vitest';
import { mergeRechargeCallbackResult, recordServerLoginNetwork } from './recharge-bank-callback';
import { safeDocument } from './recharge-validation';

describe('充值邮箱元数据与银行认证回执', () => {
  it('首次核实时间由 API 生成，后续失败与重复回调保留首次事实但不放行本轮', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-04T05:18:25.901Z'));
      const job = {
        id: 'synthetic-job',
        ownerId: 'synthetic-owner',
        action: 'server',
        accountKey: 'a'.repeat(64),
        expectedEmailEncrypted: 'synthetic-encrypted',
        result: { expected_proxy_country: 'PH', payment_requests_sent: 0 }
      };
      const accounts = {
        decryptExpectedEmail: vi.fn().mockReturnValue('fixture@example.test'),
        recordVerifiedLoginNetwork: vi.fn().mockResolvedValue(undefined)
      };
      const report = {
        stage: 'login_verified',
        account_matched: true,
        network: { ip: '8.8.8.8', country: 'PH' }
      };
      const verifiedAt = await recordServerLoginNetwork(
        {} as never,
        job as never,
        report,
        accounts as never
      );
      const first = mergeRechargeCallbackResult(job as never, report, verifiedAt);
      expect(first).toMatchObject({ first_session_verified_at: '2026-10-04T05:18:25.901Z' });
      const failure = mergeRechargeCallbackResult({ ...job, result: first } as never, {
        stage: 'session_restore',
        account_matched: false,
        session_phase: 'subscription_check',
        first_session_verified_at: '2099-01-01T00:00:00.000Z',
        payment_requests_sent: 0
      });
      expect(failure).toMatchObject({
        first_session_verified_at: verifiedAt,
        account_matched: false,
        stage: 'session_restore',
        payment_requests_sent: 0
      });
      vi.setSystemTime(new Date('2026-10-04T05:19:00.000Z'));
      const repeatedAt = await recordServerLoginNetwork(
        {} as never,
        job as never,
        report,
        accounts as never
      );
      expect(
        mergeRechargeCallbackResult({ ...job, result: failure } as never, report, repeatedAt)
      ).toMatchObject({ first_session_verified_at: verifiedAt, account_matched: true });
      accounts.recordVerifiedLoginNetwork.mockRejectedValueOnce(new Error('核实失败'));
      await expect(
        recordServerLoginNetwork({} as never, job as never, report, accounts as never)
      ).rejects.toThrow('核实失败');
    } finally {
      vi.useRealTimers();
    }
  });

  it('执行器伪造的首次核实时间被丢弃，旧记录与付款事实保持兼容', async () => {
    const forged = { first_session_verified_at: '2026-10-04T05:18:25.901Z' };
    expect(safeDocument(forged)).toEqual({});
    const job = {
      action: 'server',
      result: {
        account_matched: true,
        payment_attempted: true,
        payment_status: 'paid',
        payment_requests_sent: 1
      }
    };
    const merged = mergeRechargeCallbackResult(job as never, {
      ...forged,
      account_matched: false,
      payment_status: 'not_attempted',
      payment_requests_sent: 0
    });
    expect(merged).toMatchObject({
      account_matched: false,
      payment_status: 'paid',
      payment_requests_sent: 1
    });
    expect(merged).not.toHaveProperty('first_session_verified_at');
    expect(
      await recordServerLoginNetwork({} as never, job as never, {
        stage: 'session_restore',
        account_matched: false
      })
    ).toBeUndefined();
    await expect(
      recordServerLoginNetwork({} as never, job as never, {
        stage: 'login_verified',
        account_matched: true
      })
    ).rejects.toThrow('已限制登录');
  });

  it('新阶段与页面标题步骤受控，错误码及异常类别不接受任意正文', () => {
    const report = {
      session_phase: 'subscription_check',
      session_step: 'page_title',
      browser_error_code: 'NS_ERROR_PROXY_CONNECTION_REFUSED',
      error_type: 'Error'
    };
    expect(safeDocument({ ...report, raw_error: 'synthetic-private' })).toEqual(report);
    expect(
      safeDocument({
        session_phase: 'private',
        session_step: 'private',
        browser_error_code: 'NS_ERROR_NET_RESET_PRIVATE',
        error_type: 'private'
      })
    ).toEqual({});
  });

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
