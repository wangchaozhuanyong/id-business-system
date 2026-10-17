import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeBitBrowserLaunch, V2RechargeDetails } from './contracts';
import type { DirectLoginHooks } from './bitbrowser-direct-login';
import type { DirectPaymentHooks } from './bitbrowser-direct-payment';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import { directPaymentControls, startDirectPayment } from './direct-payment-task';

const mocks = vi.hoisted(() => ({
  callback: vi.fn(),
  grant: vi.fn(),
  cancel: vi.fn(),
  login: vi.fn(),
  run: vi.fn(),
  recheck: vi.fn(),
  clicked: vi.fn(),
  verify: vi.fn()
}));
vi.mock('./api', () => ({
  rechargeApi: {
    directBrowserCallback: mocks.callback,
    confirmDirectPayment: mocks.grant,
    cancelBitBrowser: mocks.cancel
  }
}));
vi.mock('./bitbrowser-direct-login', () => ({ runDirectLogin: mocks.login }));
vi.mock('./bitbrowser-direct-payment', () => ({ runDirectPayment: mocks.run }));
vi.mock('./bitbrowser-direct-recheck', () => ({ runDirectPaymentRecheck: mocks.recheck }));
const id = 'synthetic-direct-job';
const sid = 'oaics_SyntheticCheckout';
const upgrade = `upg_${'a'.repeat(32)}`;
let input: Parameters<typeof startDirectPayment>[0];
const finished = () =>
  mocks.callback.mock.calls
    .filter((call) => call[2].type === 'finished')
    .map((call) => call[2].result);
async function pending() {
  await vi.waitFor(() => expect(directPaymentControls.get(id)?.pending).toBe(true));
}
async function complete() {
  await vi.waitFor(() => expect(directPaymentControls.has(id)).toBe(false));
}
beforeEach(() => {
  vi.resetAllMocks();
  const launch = {
    id,
    mode: 'payment',
    transport: 'web_direct',
    agentToken: 'synthetic-agent',
    connectorUrl: '',
    connectorToken: '',
    bitBrowser: {
      localApiUrl: 'http://127.0.0.1:54345',
      localApiToken: 'synthetic-pairing',
      dynamicProxyUrl: ''
    },
    address: {},
    safety: { lockedCurrency: 'USD', authorizeSinglePayment: true, manualPaymentConfirmation: true }
  } as V2RechargeBitBrowserLaunch;
  input = {
    launch,
    plan: 'plus',
    credential: { login: { email: 'synthetic@example.test', password: 'synthetic-password' } },
    payment: { number: '4242424242424242', cvc: '123', expiry: '12/31' } as V2RechargeDetails,
    windowName: '离线测试',
    signal: new AbortController().signal,
    refresh: vi.fn().mockResolvedValue(undefined),
    reportError: vi.fn()
  };
  mocks.callback.mockImplementation(async (_id, _token, body) =>
    body.type === 'direct_quote'
      ? {
          ok: true,
          nonce: 'synthetic-single-nonce',
          quote_digest: 'b'.repeat(64),
          confirmation_expires_at: new Date(Date.now() + 60000).toISOString()
        }
      : { ok: true }
  );
  mocks.grant.mockResolvedValue({ id, paymentAllowed: true, paymentRecordRevision: 1 });
  mocks.cancel.mockResolvedValue({ id });
  mocks.login.mockImplementation(
    async (_settings, _credential, _name, signal, hooks: DirectLoginHooks) =>
      hooks.ready!({
        cdp: { onClose: () => () => undefined },
        sessionId: 'synthetic-root',
        signal,
        identity: {
          accountId: 'synthetic-account',
          userId: 'synthetic-user',
          email: 'synthetic@example.test',
          plan: 'free'
        },
        profileId: 'synthetic-profile'
      } as unknown as VerifiedPaymentBrowser)
  );
  mocks.run.mockImplementation(
    async (_browser, _launch, _plan, _payment, hooks: DirectPaymentHooks) => {
      await hooks.confirm(
        {
          checkout_identifier: sid,
          payment_attempted: false,
          payment_requests_sent: 0,
          confirmation_requests_sent: 0
        },
        mocks.verify
      );
      mocks.clicked();
      return {
        status: 'payment_result_unknown',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1,
        payment_status: 'unknown'
      };
    }
  );
});
afterEach(async () => {
  for (const control of directPaymentControls.values())
    await control.cancel().catch(() => undefined);
  directPaymentControls.clear();
  vi.useRealTimers();
});
describe('网页充值持久单次授权', () => {
  it('人工确认前零付款，授权成功后只执行一次并清空本次秘密', async () => {
    await startDirectPayment(input);
    await pending();
    expect(mocks.clicked).not.toHaveBeenCalled();
    const control = directPaymentControls.get(id)!;
    await Promise.all([control.confirm(), control.confirm()]);
    await complete();
    expect(mocks.grant).toHaveBeenCalledExactlyOnceWith(
      id,
      { nonce: 'synthetic-single-nonce', quoteDigest: 'b'.repeat(64), checkoutIdentifier: sid },
      expect.any(Object)
    );
    expect(mocks.clicked).toHaveBeenCalledOnce();
    expect(input.payment.number).toBe('');
    expect(input.payment.cvc).toBe('');
    expect(input.launch.agentToken).toBe('');
  });
  it('升级原单也使用严格checkoutIdentifier字段', async () => {
    mocks.run.mockImplementation(
      async (_browser, _launch, _plan, _payment, hooks: DirectPaymentHooks) => {
        await hooks.confirm(
          { operation: 'subscription_upgrade', upgrade_identifier: upgrade },
          mocks.verify
        );
        mocks.clicked();
        return { status: 'payment_result_unknown' };
      }
    );
    await startDirectPayment(input);
    await pending();
    await directPaymentControls.get(id)!.confirm();
    await complete();
    expect(mocks.grant.mock.calls[0]?.[1]).toEqual({
      nonce: 'synthetic-single-nonce',
      quoteDigest: 'b'.repeat(64),
      checkoutIdentifier: upgrade
    });
    expect(mocks.grant.mock.calls[0]?.[1]).not.toHaveProperty('upgradeIdentifier');
  });
  it.each(['400过期拒绝', '请求超时未到服务端', '已消费但响应丢失'])(
    '%s：不点击、不重发，按实际零观察结束并由服务器单调合并',
    async (reason) => {
      mocks.grant.mockRejectedValue(new Error(reason));
      await startDirectPayment(input);
      await pending();
      const control = directPaymentControls.get(id)!;
      await control.confirm();
      await complete();
      await control.confirm();
      expect(mocks.grant).toHaveBeenCalledOnce();
      expect(mocks.clicked).not.toHaveBeenCalled();
      expect(finished().at(-1)).toMatchObject({
        status: 'payment_result_unknown',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        payment_status: 'not_attempted'
      });
    }
  );
  it('授权结果不明且终态回执也丢失时，仅尝试服务端安全取消，不点击', async () => {
    mocks.grant.mockRejectedValue(new Error('transport'));
    const original = mocks.callback.getMockImplementation()!;
    mocks.callback.mockImplementation((...args) =>
      args[2].type === 'finished' ? Promise.reject(new Error('transport')) : original(...args)
    );
    await startDirectPayment(input);
    await pending();
    await directPaymentControls.get(id)!.confirm();
    await complete();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.clicked).not.toHaveBeenCalled();
  });
  it('人工核价失效时不申请授权也不点击', async () => {
    mocks.verify.mockRejectedValue(new Error('账单资料已变化'));
    await startDirectPayment(input);
    await pending();
    await directPaymentControls.get(id)!.confirm();
    await complete();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.clicked).not.toHaveBeenCalled();
  });
  it('非法确认过期时间停止，不把nonce恢复到页面草稿', async () => {
    mocks.callback.mockImplementation(async (_id, _token, body) =>
      body.type === 'direct_quote'
        ? {
            nonce: 'synthetic-nonce',
            quote_digest: 'b'.repeat(64),
            confirmation_expires_at: 'invalid'
          }
        : { ok: true }
    );
    await startDirectPayment(input);
    await complete();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.clicked).not.toHaveBeenCalled();
  });
  it('只读复查调用独立读取器，不能到达付款执行器', async () => {
    input.recheck = { checkout_identifier: sid };
    mocks.recheck.mockResolvedValue({
      status: 'payment_result_unknown',
      recheck_only: true,
      payment_requests_sent: 0
    });
    await startDirectPayment(input);
    await complete();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.recheck).toHaveBeenCalledOnce();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('复查先等原付款账本CAS收尾，再发送零新请求的finished', async () => {
    input.recheck = { checkout_identifier: sid };
    const ledger = {
      type: 'ledger',
      accountKey: 'c'.repeat(64),
      fileKey: `payments/${'d'.repeat(64)}.json`,
      revision: 3,
      document: {
        checkout_identifier: sid,
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1,
        payment_status: 'paid'
      }
    };
    let resolveLedger!: (value: object) => void;
    const original = mocks.callback.getMockImplementation()!;
    mocks.callback.mockImplementation((...args) =>
      args[2].type === 'ledger'
        ? new Promise((resolve) => {
            resolveLedger = resolve;
          })
        : original(...args)
    );
    mocks.recheck.mockImplementation(
      async (_browser, _plan, _source, _restored, persist: (body: object) => Promise<object>) => {
        await persist(ledger);
        return {
          status: 'subscription_activated',
          recheck_only: true,
          payment_status: 'paid',
          payment_requests_sent: 0,
          confirmation_requests_sent: 0
        };
      }
    );
    await startDirectPayment(input);
    await vi.waitFor(() => expect(resolveLedger).toBeTypeOf('function'));
    expect(finished()).toHaveLength(0);
    resolveLedger({ revision: 4 });
    await complete();
    const events = mocks.callback.mock.calls.map((call) => call[2].type);
    expect(events.indexOf('ledger')).toBeLessThan(events.indexOf('finished'));
    expect(finished().at(-1)).toMatchObject({
      status: 'subscription_activated',
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      recheck_only: true
    });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.clicked).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    '官网实际观察到未授权确认（回执丢失=%s），持久unknown且绝不安全取消或重发',
    async (lost) => {
      const original = mocks.callback.getMockImplementation()!;
      mocks.callback.mockImplementation((...args) => {
        if (args[2].type === 'direct_unexpected_payment')
          return lost
            ? Promise.reject(new Error('transport'))
            : Promise.resolve({ ok: true, paymentLocked: true });
        if (args[2].type === 'finished' && lost) return Promise.reject(new Error('transport'));
        return original(...args);
      });
      mocks.run.mockImplementation(
        async (_browser, _launch, _plan, _payment, hooks: DirectPaymentHooks) => {
          await hooks.unexpected({
            checkout_identifier: sid,
            account_matched: true,
            current_plan_before: 'free',
            target_plan: 'plus',
            payment_requests_sent: 1,
            confirmation_requests_sent: 1
          });
          throw new Error('原窗口观察到付款');
        }
      );
      await startDirectPayment(input);
      await complete();
      expect(
        mocks.callback.mock.calls.find((call) => call[2].type === 'direct_unexpected_payment')?.[2]
      ).toEqual({
        type: 'direct_unexpected_payment',
        result: {
          checkout_identifier: sid,
          account_matched: true,
          current_plan_before: 'free',
          target_plan: 'plus',
          payment_requests_sent: 1,
          confirmation_requests_sent: 1
        }
      });
      expect(finished().at(-1)).toMatchObject({
        status: 'payment_result_unknown',
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1,
        payment_status: 'unknown'
      });
      expect(mocks.cancel).not.toHaveBeenCalled();
      expect(mocks.clicked).not.toHaveBeenCalled();
      expect(mocks.grant).not.toHaveBeenCalled();
    }
  );
});
