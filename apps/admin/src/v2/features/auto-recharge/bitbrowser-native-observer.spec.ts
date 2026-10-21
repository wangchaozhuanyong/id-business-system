import { describe, expect, it, vi } from 'vitest';
import type { V2RechargeDetails } from './contracts';
import { DirectPaymentObserver } from './bitbrowser-payment-observer';
import { NATIVE_QUOTE_BODY_LIMIT } from './bitbrowser-native-quote';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';

const checkoutId = 'oaics_native_observer_fixture';
const accountId = 'native-fixture-account';
const details: V2RechargeDetails = {
  number: '4242424242424242',
  expiry: '10/31',
  cvc: '123',
  name: 'Synthetic Buyer',
  email: 'native@example.invalid',
  country: 'US',
  line1: '100 Test Avenue',
  line2: '',
  city: 'Eugene',
  state: 'OR',
  postal_code: '97402'
};
const request = () => ({
  billing_address: { ...details },
  billing_country: 'US',
  billing_name: details.name,
  checkout_email: details.email,
  checkout_session_id: checkoutId,
  currency: 'php',
  processor_entity: 'openai_llc',
  tax_id: null
});
const response = () => ({
  using_automatic_tax: false,
  checkout_session: {
    checkout_session_id: checkoutId,
    processor_entity: 'openai_llc',
    plan_name: 'chatgptplusplan',
    status: 'open',
    payment_status: 'unpaid',
    client_secret: 'never-retain-processor-secret',
    checkout_state: {
      id: checkoutId,
      currency: 'php',
      taxIdInfo: null,
      total: { total: { minorUnitsAmount: 98214 } },
      lineItems: [{ quantity: 1, recurring: { interval: 'month', intervalCount: 1 } }],
      taxAmounts: [{ minorUnitsAmount: 0 }],
      billingAddress: { name: details.name, address: { ...details } }
    }
  }
});
const token = (account = accountId) =>
  'synthetic.' +
  Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': { chatgpt_account_id: account }
    })
  ).toString('base64url') +
  '.synthetic';
type Handler = (method: string, params: Record<string, unknown>, session?: string) => void;
function fixture() {
  let handler: Handler | undefined;
  let sequence = 0;
  const owned = new Set(['owned', 'owned-child']);
  const bodies = new Map<string, Promise<Record<string, unknown>> | Record<string, unknown>>();
  const command = vi.fn(async (_method: string, params: { requestId: string }) => {
    const result = bodies.get(params.requestId);
    if (!result) throw new Error('synthetic response unavailable');
    return await result;
  });
  const remove = vi.fn(() => {
    handler = undefined;
  });
  const browser = {
    cdp: {
      onEvent: (next: Handler) => {
        handler = next;
        return remove;
      },
      command
    },
    sessionId: 'owned',
    profileId: 'f'.repeat(32),
    signal: new AbortController().signal,
    identity: { accountId, userId: 'native-fixture-user', email: details.email, plan: 'free' }
  } as unknown as VerifiedPaymentBrowser;
  const observer = new DirectPaymentObserver(browser, { checkoutId }, (session) =>
    owned.has(session)
  );
  observer.trackNativeBilling(checkoutId, 'openai_llc', 'plus', 'PHP');
  function begin(
    options: {
      data?: unknown;
      account?: string;
      headerAccount?: string;
      path?: string;
      session?: string;
      headers?: Record<string, string>;
      method?: string;
      raw?: string;
    } = {}
  ) {
    const id = String(++sequence),
      session = options.session ?? 'owned';
    handler?.(
      'Network.requestWillBeSent',
      {
        requestId: id,
        request: {
          url: 'https://chatgpt.com' + (options.path ?? '/backend-api/payments/checkout/taxes'),
          method: options.method ?? 'POST',
          postData: options.raw ?? JSON.stringify(options.data ?? request()),
          headers: options.headers ?? {
            authorization: 'Bearer ' + token(options.account),
            'chatgpt-account-id': options.headerAccount ?? accountId
          }
        }
      },
      session
    );
    return { id, session };
  }
  function finish(
    item: { id: string; session: string },
    value: unknown = response(),
    options: {
      status?: number;
      length?: number;
      encodedLength?: number;
      base64?: boolean;
      delayed?: Promise<Record<string, unknown>>;
      unavailable?: boolean;
      failed?: boolean;
    } = {}
  ) {
    if (!options.unavailable)
      bodies.set(
        item.id,
        options.delayed ?? {
          body: typeof value === 'string' ? value : JSON.stringify(value),
          base64Encoded: options.base64 ?? false
        }
      );
    handler?.(
      'Network.responseReceived',
      {
        requestId: item.id,
        response: {
          status: options.status ?? 200,
          headers: options.length ? { 'content-length': String(options.length) } : {}
        }
      },
      item.session
    );
    handler?.(
      options.failed ? 'Network.loadingFailed' : 'Network.loadingFinished',
      {
        requestId: item.id,
        encodedDataLength: options.encodedLength ?? 100
      },
      item.session
    );
  }
  return { observer, begin, finish, owned, command, remove, bodies };
}

describe('原生计税被动观察与确认版本屏障', () => {
  it('旧GET账单不能覆盖新taxes完整报价，也不保留响应秘密', async () => {
    const f = fixture();
    const old = response().checkout_session;
    old.checkout_state.billingAddress.address.line1 = 'Old Test Address';
    f.finish(
      f.begin({ method: 'GET', path: '/backend-api/payments/checkout/openai_llc/' + checkoutId }),
      old
    );
    await f.observer.settle();
    expect(f.observer.nativeBilling(details)).toMatchObject({ observed: false, pending: false });
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    f.finish(f.begin());
    await f.observer.settle();
    const result = f.observer.nativeBilling(details);
    expect(result).toMatchObject({
      observed: true,
      pending: false,
      document: { checkout_session_id: checkoutId }
    });
    expect(JSON.stringify(result.document)).not.toContain('never-retain-processor-secret');
    expect(JSON.stringify(result.document)).not.toContain(details.number);
    const changed = structuredClone(result.document!);
    changed.checkout_session_id = 'oaics_changed';
    expect(f.observer.nativeBilling(details).document?.checkout_session_id).toBe(checkoutId);
  });
  it.each([true, false])(
    '省略tax_id的真实请求只有明确无税号响应才产生报价：%s',
    async (hasProof) => {
      const f = fixture();
      const raw = request();
      Reflect.deleteProperty(raw, 'tax_id');
      const quote = response();
      if (!hasProof) Reflect.deleteProperty(quote.checkout_session.checkout_state, 'taxIdInfo');
      f.finish(f.begin({ data: raw }), quote);
      await f.observer.settle();
      const result = f.observer.nativeBilling(details);
      expect(result.pending).toBe(false);
      if (hasProof) {
        expect(result.document).toMatchObject({ checkout_session_id: checkoutId });
        expect(result.error).toBeUndefined();
      } else {
        expect(result.document).toBeUndefined();
        expect(result.error).toBe('native_billing_response_tax_context_unverified');
      }
    }
  );
  it('loadingFinished之后body尚未读取完成仍保持pending，旧版本不能确认', async () => {
    const f = fixture();
    const before = f.observer.nativeBilling(details);
    let resolve!: (value: Record<string, unknown>) => void;
    const delayed = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    const item = f.begin();
    f.finish(item, undefined, { delayed });
    expect(f.observer.nativeBilling(details)).toMatchObject({ pending: true, observed: true });
    expect(f.observer.nativeBilling(details).changedAt).toBeGreaterThan(before.changedAt);
    expect(() => f.observer.assertNativeBillingVersion(before.version)).toThrow(
      'native_billing_version_changed'
    );
    resolve({ body: JSON.stringify(response()), base64Encoded: false });
    await f.observer.settle();
    const complete = f.observer.nativeBilling(details);
    expect(complete.pending).toBe(false);
    expect(complete.document).toBeDefined();
    expect(() => f.observer.assertNativeBillingVersion(complete.version)).not.toThrow();
  });
  it('新taxes立刻清旧快照且只接纳最新taxes，乱序旧响应不能覆盖', async () => {
    const f = fixture();
    f.finish(f.begin());
    await f.observer.settle();
    const previous = f.observer.nativeBilling(details);
    const first = f.begin(),
      second = f.begin();
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    f.finish(second);
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).pending).toBe(true);
    const stale = response();
    stale.checkout_session.checkout_state.billingAddress.address.state = 'CA';
    f.finish(first, stale);
    await f.observer.settle();
    const latest = f.observer.nativeBilling(details);
    expect(latest).toMatchObject({ pending: false, observed: true });
    expect(latest.document).toBeDefined();
    expect(latest.error).toBeUndefined();
    expect(() => f.observer.assertNativeBillingVersion(previous.version)).toThrow();
  });
  it('同单tax_id只作为版本屏障，成功静默后可以保留同地址taxes快照', async () => {
    const f = fixture();
    f.finish(f.begin());
    await f.observer.settle();
    const previous = f.observer.nativeBilling(details);
    const item = f.begin({
      path: '/backend-api/payments/checkout/update_tax_id',
      data: {
        checkout_session_id: checkoutId,
        tax_id_info: null
      }
    });
    expect(f.observer.nativeBilling(details)).toMatchObject({ observed: true, pending: true });
    expect(() => f.observer.assertNativeBillingVersion(previous.version)).toThrow();
    f.finish(item, { success: true, checkout_session: response().checkout_session });
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).document).toEqual(previous.document);
    expect(f.command).toHaveBeenCalledTimes(2);
  });
  it('tax_id最新响应可以更新金额，迟到taxes不能覆盖它', async () => {
    const f = fixture();
    const taxes = f.begin();
    const update = f.begin({
      path: '/backend-api/payments/checkout/update_tax_id',
      data: {
        checkout_session_id: checkoutId,
        tax_id_info: null
      }
    });
    const current = response().checkout_session;
    current.checkout_state.total.total.minorUnitsAmount = 100000;
    f.finish(update, { success: true, checkout_session: current });
    await f.observer.settle();
    f.finish(taxes);
    await f.observer.settle();
    expect(JSON.stringify(f.observer.nativeBilling(details).document)).toContain('100000');
  });
  it('旧tax_id延迟失败不能污染新taxes序列的已验证报价', async () => {
    const f = fixture();
    f.finish(f.begin());
    await f.observer.settle();
    const old = f.begin({
      path: '/backend-api/payments/checkout/update_tax_id',
      data: {
        checkout_session_id: checkoutId,
        tax_id_info: null
      }
    });
    f.finish(f.begin());
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).pending).toBe(true);
    f.finish(old, undefined, { failed: true });
    await f.observer.settle();
    expect(f.observer.nativeBilling(details)).toMatchObject({ pending: false });
    expect(f.observer.nativeBilling(details).document).toBeDefined();
    expect(f.observer.nativeBilling(details).error).toBeUndefined();
  });
  it.each([undefined, '', {}, 'synthetic-tax-id'])(
    '只接受已证实的严格null税号上下文：%j',
    async (tax_id_info) => {
      const f = fixture();
      f.finish(f.begin());
      await f.observer.settle();
      f.finish(
        f.begin({
          path: '/backend-api/payments/checkout/update_tax_id',
          data: {
            checkout_session_id: checkoutId,
            tax_id_info
          }
        }),
        { success: true, checkout_session: response().checkout_session }
      );
      await f.observer.settle();
      expect(f.observer.nativeBilling(details).error).toBe('native_billing_tax_context_unverified');
      expect(f.observer.nativeBilling(details).document).toBeUndefined();
    }
  );
  it('没有先前taxes账单锚点时，tax_id即使返回完整响应也不能成为报价', async () => {
    const f = fixture();
    f.finish(
      f.begin({
        path: '/backend-api/payments/checkout/update_tax_id',
        data: {
          checkout_session_id: checkoutId,
          tax_id_info: null
        }
      }),
      { success: true, checkout_session: response().checkout_session }
    );
    await f.observer.settle();
    expect(f.observer.nativeBilling(details)).toMatchObject({
      observed: true,
      error: 'native_billing_tax_context_unverified'
    });
  });
  it('tax_id的200空响应不能靠旧报价或GET掩盖', async () => {
    const f = fixture();
    f.finish(f.begin());
    await f.observer.settle();
    f.finish(
      f.begin({
        path: '/backend-api/payments/checkout/update_tax_id',
        data: {
          checkout_session_id: checkoutId,
          tax_id_info: null
        }
      }),
      { success: true }
    );
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    expect(f.observer.nativeBilling(details).error).toMatch(/^native_billing_/);
  });
  it.each([
    { account: 'other-account' },
    { headerAccount: 'other-account' },
    { headers: {} },
    { data: { ...request(), checkout_session_id: 'oaics_other' } },
    { data: { ...request(), processor_entity: 'other_entity' } },
    { data: { ...request(), currency: 'USD' } },
    { data: { ...request(), checkout_email: 'other@example.invalid' } },
    { data: { ...request(), billing_country: 'CA' } },
    { data: { ...request(), billing_address: { ...details, country: 'CA' } } },
    { data: { ...request(), billing_name: 'Other Buyer' } },
    { raw: '{invalid' }
  ])('错误请求不能被GET回退掩盖：%j', async (options) => {
    const f = fixture();
    f.finish(f.begin(options));
    await f.observer.settle();
    const result = f.observer.nativeBilling(details);
    expect(result).toMatchObject({ observed: true, pending: false });
    expect(result.document).toBeUndefined();
    expect(result.error).toMatch(/^native_billing_/);
  });
  it.each([
    { status: 400 },
    { failed: true },
    { unavailable: true },
    { base64: true },
    { length: NATIVE_QUOTE_BODY_LIMIT + 1 },
    { encodedLength: NATIVE_QUOTE_BODY_LIMIT + 1 }
  ])('HTTP、网络、body读取或超限失败保留observed并释放在途：%j', async (options) => {
    const f = fixture();
    f.finish(f.begin(), response(), options);
    await f.observer.settle();
    const result = f.observer.nativeBilling(details);
    expect(result).toMatchObject({ observed: true, pending: false });
    expect(result.document).toBeUndefined();
    expect(result.error).toMatch(/^native_billing_/);
    expect(() => f.observer.assertNativeBillingVersion(result.version)).toThrow();
  });
  it.each(['{invalid', 'x'.repeat(NATIVE_QUOTE_BODY_LIMIT + 1)])(
    '不保留畸形或超限原文',
    async (raw) => {
      const f = fixture();
      f.finish(f.begin(), raw);
      await f.observer.settle();
      expect(f.observer.nativeBilling(details)).toMatchObject({ observed: true, pending: false });
      expect(f.observer.nativeBilling(details).error).toMatch(/^native_billing_/);
    }
  );
  it.each(['order', 'entity', 'plan', 'currency', 'address', 'email'])(
    '响应%s绑定不符不产生报价',
    async (kind) => {
      const f = fixture(),
        raw = response();
      if (kind === 'order') raw.checkout_session.checkout_session_id = 'oaics_other';
      if (kind === 'entity') raw.checkout_session.processor_entity = 'other_entity';
      if (kind === 'plan') raw.checkout_session.plan_name = 'chatgptgoplan';
      if (kind === 'currency') raw.checkout_session.checkout_state.currency = 'usd';
      if (kind === 'address')
        raw.checkout_session.checkout_state.billingAddress.address.line1 = 'Other Address';
      if (kind === 'email')
        Object.assign(raw.checkout_session, { checkout_email: 'other@example.invalid' });
      f.finish(f.begin(), raw);
      await f.observer.settle();
      expect(f.observer.nativeBilling(details).document).toBeUndefined();
      expect(f.observer.nativeBilling(details).error).toMatch(/^native_billing_/);
    }
  );
  it('采集后当前资料或email变化仍拒绝已有报价', async () => {
    const f = fixture();
    f.finish(f.begin());
    await f.observer.settle();
    expect(f.observer.nativeBilling({ ...details, state: 'CA' }).error).toBe(
      'native_billing_details_address_mismatch'
    );
    expect(f.observer.nativeBilling({ ...details, email: 'other@example.invalid' }).error).toBe(
      'native_billing_details_email_mismatch'
    );
  });
  it('非owned会话不采集；owned子会话可采集，读取中失去归属则拒绝', async () => {
    const f = fixture();
    f.finish(f.begin({ session: 'foreign' }));
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).observed).toBe(false);
    f.finish(f.begin({ session: 'owned-child' }));
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).document).toBeDefined();
    let resolve!: (value: Record<string, unknown>) => void;
    const delayed = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    f.finish(f.begin({ session: 'owned-child' }), undefined, { delayed });
    f.owned.delete('owned-child');
    resolve({ body: JSON.stringify(response()) });
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).error).toBe('native_billing_session_changed');
  });
  it('关闭会清除快照和在途，迟到body不再复活报价', async () => {
    const f = fixture();
    let resolve!: (value: Record<string, unknown>) => void;
    const delayed = new Promise<Record<string, unknown>>((done) => {
      resolve = done;
    });
    f.finish(f.begin(), undefined, { delayed });
    const previous = f.observer.nativeBilling(details);
    f.observer.close();
    resolve({ body: JSON.stringify(response()) });
    await f.observer.settle();
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.observer.nativeBilling(details)).toMatchObject({
      pending: false,
      observed: false,
      error: 'native_billing_observer_closed'
    });
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    expect(() => f.observer.assertNativeBillingVersion(previous.version)).toThrow();
  });
  it('重新跟踪使旧响应不能写入新一轮快照', async () => {
    const f = fixture();
    const old = f.begin();
    f.observer.trackNativeBilling(checkoutId, 'openai_llc', 'plus', 'PHP');
    f.finish(old);
    await f.observer.settle();
    expect(f.observer.nativeBilling(details)).toMatchObject({ pending: false, observed: false });
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
  });
  it('armed后出现原生更新会撤销可采纳的付款证据', async () => {
    const f = fixture();
    f.finish(f.begin());
    await f.observer.settle();
    const verified = f.observer.nativeBilling(details);
    f.observer.arm();
    f.begin();
    expect(f.observer.failure).toBe('native_billing_changed_after_confirmation');
    expect(f.observer.paymentStatus).toBe('unknown');
    expect(f.observer.confirmationRequests).toBe(0);
    expect(() => f.observer.assertNativeBillingVersion(verified.version)).toThrow();
  });
});
