import { describe, expect, it, vi } from 'vitest';
import { OnlineBitbrowserCompletionService } from './bitbrowser-completion.service';

function fixture(plan: 'plus' | 'pro_5x' | 'pro_20x' = 'plus') {
  const account = 'completion-fixture-account';
  const row = {
    id: 'task',
    plan,
    payload: {},
    paymentStarted: true,
    cardId: 'card',
    sessionEncrypted: JSON.stringify({
      accessToken: `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.x`
    })
  };
  const document: Record<string, unknown> = {
    account_key: 'account-key',
    target_plan: plan === 'plus' ? 'plus' : plan === 'pro_5x' ? 'pro-5x' : 'pro-20x',
    quote_digest: 'bound-quote',
    payment_status: 'paid',
    checkout_identifier: 'cs_fixture',
    payment_evidence: {
      kind: 'checkout_session',
      identifier: 'cs_fixture',
      amount_minor: 2000,
      currency: 'USD'
    }
  };
  const state = {
    deviceId: 'device',
    paymentConsumed: true,
    accountKey: 'account-key',
    quoteDigest: 'bound-quote',
    quote: { today: { amount: '20.00', amount_minor: 2000, currency: 'USD' } },
    get ledgerEncrypted() {
      return JSON.stringify({ file: { document } });
    }
  };
  const workers = {
    withLease: async (_rpc: unknown, work: (tx: unknown, row: unknown) => unknown) => work({}, row),
    markAddress: vi.fn(),
    cardAction: vi.fn(),
    billing: vi.fn(),
    finish: vi.fn(async (rpc) => ({ ok: true, status: rpc.args.status }))
  };
  const credentials = { releaseCvc: vi.fn() };
  const service = new OnlineBitbrowserCompletionService(
    {} as never,
    workers as never,
    { owned: async () => state } as never,
    { decrypt: (value: string) => value } as never,
    credentials as never
  );
  const finish = (result: Record<string, unknown>) =>
    service.finish({ method: 'callback', args: { result } }, {} as never);
  const observed = {
    account_matched: true,
    status: 'subscription_activated',
    current_plan: 'plus'
  };
  return { row, state, document, workers, credentials, finish, observed };
}
describe('比特付款结果闭环', () => {
  it('原付款凭据、账号与套餐一致才成功，并使用原单记账及释放临时安全码', async () => {
    const f = fixture();
    expect(await f.finish(f.observed)).toMatchObject({ status: 'succeeded' });
    expect(f.workers.billing).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          status: 'success',
          amount: '20.00',
          currency: 'USD',
          checkoutId: 'cs_fixture'
        })
      })
    );
    expect(f.credentials.releaseCvc).toHaveBeenCalledWith('card', 'task');
  });
  it('账号不一致、未核实套餐或 Pro 倍率不一致均保留原单待核对', async () => {
    for (const change of [{ account_matched: false }, { current_plan: 'free' }]) {
      const f = fixture();
      expect(await f.finish({ ...f.observed, ...change })).toMatchObject({
        status: 'awaiting_review'
      });
    }
    const f = fixture('pro_5x');
    expect(await f.finish({ ...f.observed, current_plan: 'pro', current_tier: 20 })).toMatchObject({
      status: 'awaiting_review'
    });
  });
  it('浏览器声称成功不能替代原始付款证据及提交标记', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.state.paymentConsumed = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.document.payment_evidence = {
          kind: 'checkout_session',
          identifier: 'cs_other',
          amount_minor: 2000,
          currency: 'USD'
        };
      },
      (f: ReturnType<typeof fixture>) => {
        f.document.quote_digest = 'other';
      }
    ]) {
      const f = fixture();
      mutate(f);
      expect(await f.finish(f.observed)).toMatchObject({ status: 'awaiting_review' });
      expect(f.workers.billing).not.toHaveBeenCalled();
    }
  });
  it('升级发票绑定原升级单且 Pro 倍率确认后可完成', async () => {
    const f = fixture('pro_20x');
    Object.assign(f.document, {
      operation: 'subscription_upgrade',
      upgrade_invoice_identifier: 'in_fixture',
      payment_evidence: {
        kind: 'invoice',
        identifier: 'in_fixture',
        amount_minor: 2000,
        currency: 'USD'
      }
    });
    expect(await f.finish({ ...f.observed, current_plan: 'pro', current_tier: 20 })).toMatchObject({
      status: 'succeeded'
    });
  });
  it('明确拒付释放兑换资格，结果不明保留待核对', async () => {
    const f = fixture();
    f.document.payment_status = 'unknown';
    expect(await f.finish({ payment_status: 'unknown' })).toMatchObject({
      status: 'awaiting_review'
    });
    expect(await f.finish({ payment_status: 'declined' })).toMatchObject({ status: 'failed' });
    expect(f.workers.cardAction).toHaveBeenCalledWith(
      expect.objectContaining({ args: { cardId: 'card' } }),
      'recordCardDecline'
    );
  });
  it('付款前失败不产生账单', async () => {
    const f = fixture();
    f.row.paymentStarted = false;
    f.state.paymentConsumed = false;
    expect(
      await f.finish({ status: 'blocked', reason: 'online_preparation_failed' })
    ).toMatchObject({ status: 'failed' });
    expect(f.workers.billing).not.toHaveBeenCalled();
  });
});
