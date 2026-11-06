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
const token = (account = accountId, exp = Math.floor(Date.now() / 1000) + 3600) =>
  'synthetic.' +
  Buffer.from(
    JSON.stringify({
      exp,
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
  const postBodies = new Map<string, string>();
  const command = vi.fn(async (_method: string, params: { requestId: string }) => {
    if (_method === 'Network.getRequestPostData')
      return { postData: postBodies.get(params.requestId) };
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
      omitBody?: boolean;
    } = {}
  ) {
    const id = String(++sequence),
      session = options.session ?? 'owned';
    const postData = options.raw ?? JSON.stringify(options.data ?? request());
    postBodies.set(id, postData);
    handler?.(
      'Network.requestWillBeSent',
      {
        requestId: id,
        request: {
          url: 'https://chatgpt.com' + (options.path ?? '/backend-api/payments/checkout/taxes'),
          method: options.method ?? 'POST',
          postData: options.omitBody ? undefined : postData,
          hasPostData: true,
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
  function extra(
    item: { id: string; session: string },
    headers: Record<string, string> = {
      authorization: 'Bearer ' + token(),
      'chatgpt-account-id': accountId
    }
  ) {
    handler?.('Network.requestWillBeSentExtraInfo', { requestId: item.id, headers }, item.session);
  }
  return { observer, begin, finish, extra, owned, command, remove, bodies };
}

describe('原生计税被动观察与确认版本屏障', () => {
  it.each([false, true])('被省略的正文只读补取并继续原单验证，补充头=%s', async (extra) => {
    const f = fixture();
    const item = f.begin({
      omitBody: true,
      ...(extra ? { headers: { authorization: 'Bearer ' + token() } } : {})
    });
    f.finish(item);
    if (extra) f.extra(item);
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).error).toBeUndefined();
    expect(f.observer.nativeBilling(details).document).toBeDefined();
    expect(
      f.command.mock.calls.filter(([method]) => method === 'Network.getRequestPostData')
    ).toHaveLength(1);
    expect(
      f.command.mock.calls.every(([method]) =>
        ['Network.getRequestPostData', 'Network.getResponseBody'].includes(method)
      )
    ).toBe(true);
  });

  it.each([
    ['missing', undefined, 'native_billing_request_body_missing'],
    ['invalid', '{invalid', 'native_billing_request_body_invalid'],
    ['oversized', 'x'.repeat(65001), 'native_billing_request_body_oversized'],
    [
      'wrong-order',
      JSON.stringify({ ...request(), checkout_session_id: 'oaics_other' }),
      'native_billing_request_order_mismatch'
    ]
  ] as const)('补取正文仍须完整且匹配原单：%s', async (_kind, postData, reason) => {
    const f = fixture();
    f.command.mockResolvedValueOnce({ postData });
    f.finish(f.begin({ omitBody: true }));
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).error).toBe(reason);
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    expect(
      f.command.mock.calls.filter(([method]) => method === 'Network.getRequestPostData')
    ).toHaveLength(1);
  });

  it('已有错误原单正文不能补取另一份正文覆盖', async () => {
    const f = fixture();
    f.finish(f.begin({ data: { ...request(), checkout_session_id: 'oaics_other' } }));
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).error).toBe('native_billing_request_order_mismatch');
    expect(f.command).not.toHaveBeenCalled();
  });

  it('编码正文不能当成明文JSON采纳', async () => {
    const f = fixture();
    f.command.mockResolvedValueOnce({ postData: JSON.stringify(request()), base64Encoded: true });
    f.finish(f.begin({ omitBody: true }));
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).error).toBe('native_billing_request_body_encoded');
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
  });

  it('补取失败仅回显受控原因，不记录传输错误原文或重试', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const f = fixture();
      f.command.mockRejectedValueOnce(new Error('private-post-data-error-never-log'));
      f.finish(f.begin({ omitBody: true }));
      await f.observer.settle();
      expect(f.observer.nativeBilling(details).error).toBe(
        'native_billing_request_body_unavailable'
      );
      expect(f.command).toHaveBeenCalledTimes(1);
      f.observer.close();
      expect(JSON.stringify(output.mock.calls)).not.toContain('private-post-data-error-never-log');
    } finally {
      output.mockRestore();
    }
  });

  it('税号请求等待同一轮计税正文，不能用缺失锚点或旧计税替代', async () => {
    const f = fixture();
    const tax = f.begin({ omitBody: true });
    const taxId = f.begin({
      path: '/backend-api/payments/checkout/update_tax_id',
      data: { checkout_session_id: checkoutId, tax_id_info: null }
    });
    f.finish(tax);
    f.finish(taxId, { ...response(), success: true });
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).error).toBeUndefined();
    expect(f.observer.nativeBilling(details).document).toBeDefined();
  });

  it('旧正文迟到不能污染新一轮报价', async () => {
    const f = fixture();
    let resolvePost!: (value: Record<string, unknown>) => void;
    f.command.mockImplementationOnce(
      async () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolvePost = resolve;
        })
    );
    const old = f.begin({ omitBody: true });
    const read = f.command.mock.results[0].value;
    const latest = f.begin();
    f.finish(old);
    f.finish(latest);
    await f.observer.settle();
    const version = f.observer.nativeBilling(details).version;
    resolvePost({ postData: '{invalid' });
    await read;
    await Promise.resolve();
    expect(f.observer.nativeBilling(details).error).toBeUndefined();
    expect(f.observer.nativeBilling(details).document).toBeDefined();
    expect(f.observer.nativeBilling(details).version).toBe(version);
  });

  it.each(['before', 'after', 'after-finish'] as const)(
    '基础事件漏账号头时，只接纳同请求完整头证据：%s',
    async (order) => {
      const f = fixture();
      if (order === 'before') f.extra({ id: '1', session: 'owned' });
      const item = f.begin({ headers: { authorization: 'Bearer ' + token() } });
      if (order === 'after') f.extra(item);
      f.finish(item);
      if (order === 'after-finish') f.extra(item);
      await f.observer.settle();
      expect(f.observer.nativeBilling(details).document).toBeDefined();
      expect(f.observer.nativeBilling(details).error).toBeUndefined();
      expect(f.command.mock.calls.every(([method]) => method === 'Network.getResponseBody')).toBe(
        true
      );
    }
  );

  it.each<Record<string, string>>([
    {},
    { authorization: 'Bearer ' + token() },
    { authorization: 'Bearer ' + token('other-account'), 'chatgpt-account-id': accountId },
    { authorization: 'Bearer ' + token(), 'chatgpt-account-id': 'other-account' },
    { authorization: 'Bearer ' + token(accountId, 1), 'chatgpt-account-id': accountId }
  ])('完整头仍须包含同账号有效Token和显式账号头：%j', async (headers) => {
    const f = fixture();
    const item = f.begin({ headers: { authorization: 'Bearer ' + token() } });
    f.extra(item, headers);
    f.finish(item);
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    expect(f.observer.nativeBilling(details).error).toBe('native_billing_account_mismatch');
  });

  it.each([{ account: 'other-account' }, { headerAccount: 'other-account' }])(
    '基础事件明确冲突不能被完整头修复：%j',
    async (options) => {
      const f = fixture();
      const item = f.begin(options);
      f.extra(item);
      f.finish(item);
      await f.observer.settle();
      expect(f.observer.nativeBilling(details).document).toBeUndefined();
      expect(f.observer.nativeBilling(details).error).toBe('native_billing_account_mismatch');
    }
  );

  it.each(['no-proof', 'other-request', 'other-session', 'new-generation', 'evicted'] as const)(
    '缺失或无法精确关联的完整头超时关闭：%s',
    async (mode) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        if (mode === 'other-request') f.extra({ id: 'other', session: 'owned' });
        if (mode === 'other-session') f.extra({ id: '1', session: 'owned-child' });
        if (mode === 'new-generation') {
          f.extra({ id: '1', session: 'owned' });
          f.observer.trackNativeBilling(checkoutId, 'openai_llc', 'plus', 'PHP');
        }
        if (mode === 'evicted')
          for (let id = 1; id <= 65; id++) f.extra({ id: String(id), session: 'owned' });
        const item = f.begin({ headers: { authorization: 'Bearer ' + token() } });
        f.finish(item);
        expect(f.observer.nativeBilling(details).document).toBeUndefined();
        const done = f.observer.settle();
        await vi.advanceTimersByTimeAsync(1001);
        await done;
        expect(f.observer.nativeBilling(details).error).toBe('native_billing_account_mismatch');
        // A receipt after the bounded wait cannot resurrect the failed response.
        f.extra(item);
        expect(f.observer.nativeBilling(details).document).toBeUndefined();
        expect(f.command).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('迟到的冲突完整头使已有报价及确认版本失效', async () => {
    const f = fixture();
    const item = f.begin();
    f.finish(item);
    await f.observer.settle();
    const quoted = f.observer.nativeBilling(details);
    expect(quoted.document).toBeDefined();
    f.observer.arm();
    f.extra(item, { authorization: 'Bearer ' + token(), 'chatgpt-account-id': 'other-account' });
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    expect(() => f.observer.assertNativeBillingVersion(quoted.version)).toThrow();
    expect(f.observer.failure).toBe('native_billing_changed_after_confirmation');
  });

  it('冲突的早到完整头不能被随后正常完整头覆盖', async () => {
    const f = fixture();
    const item = { id: '1', session: 'owned' };
    f.extra(item, { authorization: 'Bearer ' + token(), 'chatgpt-account-id': 'other-account' });
    f.extra(item);
    f.finish(f.begin({ headers: { authorization: 'Bearer ' + token() } }));
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    expect(f.observer.nativeBilling(details).error).toBe('native_billing_account_mismatch');
  });

  it('受控子会话只接纳自己的完整头，且旧计税不能解除新计税在途', async () => {
    const f = fixture();
    const older = f.begin({ headers: { authorization: 'Bearer ' + token() } });
    const latest = f.begin({
      session: 'owned-child',
      headers: { authorization: 'Bearer ' + token() }
    });
    f.extra(older);
    f.finish(older);
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    expect(f.observer.nativeBilling(details).pending).toBe(true);
    f.extra(latest);
    f.finish(latest);
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).document).toBeDefined();
  });

  it('计税与清空税号均等待各自完整头，不以另一个响应替代', async () => {
    const f = fixture();
    const tax = f.begin({ headers: { authorization: 'Bearer ' + token() } });
    const taxId = f.begin({
      headers: { authorization: 'Bearer ' + token() },
      path: '/backend-api/payments/checkout/update_tax_id',
      data: { checkout_session_id: checkoutId, tax_id_info: null }
    });
    f.finish(tax);
    f.finish(taxId, { ...response(), success: true });
    f.extra(taxId);
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
    f.extra(tax);
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).error).toBeUndefined();
    expect(f.observer.nativeBilling(details).document).toBeDefined();
  });

  it('完整头只留验证投影，关闭唤醒等待且不再读取原生body', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const f = fixture();
      f.extra(
        { id: 'other', session: 'owned' },
        { authorization: 'Bearer ' + token(), cookie: 'never-retain-wire-cookie' }
      );
      const item = f.begin({ headers: { authorization: 'Bearer ' + token() } });
      f.finish(item);
      f.observer.close();
      await f.observer.settle();
      const saved = JSON.stringify(f.observer, (_key, value) =>
        value instanceof Map ? [...value.entries()] : value
      );
      expect(saved).not.toContain(token());
      expect(saved).not.toContain('never-retain-wire-cookie');
      expect(f.command).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });

  it('关闭时的核价诊断仅含安全状态，不泄漏凭据、账号或账单资料', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const f = fixture();
      f.begin({ account: 'other-account' });
      f.observer.close();
      f.observer.close();
      const logged = JSON.stringify(output.mock.calls);
      expect(output.mock.calls).toHaveLength(1);
      expect(logged).toContain('native_billing_account_mismatch');
      expect(logged).toContain('token_account_mismatch');
      for (const secret of [
        details.number,
        details.cvc,
        details.email,
        details.line1,
        details.name,
        checkoutId,
        accountId,
        token()
      ])
        expect(logged).not.toContain(secret);
    } finally {
      output.mockRestore();
    }
  });

  it('诊断区分原生响应读取失败，且不记录传输错误原文', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const f = fixture();
      f.command.mockRejectedValueOnce(new Error('synthetic-private-transport-description'));
      f.finish(f.begin());
      await f.observer.settle();
      f.observer.close();
      const logged = JSON.stringify(output.mock.calls);
      expect(logged).toContain('native_billing_body_unavailable');
      expect(logged).not.toContain('synthetic-private-transport-description');
      expect(logged).not.toContain(details.number);
    } finally {
      output.mockRestore();
    }
  });
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
  it('实测清空税号响应省略 taxIdInfo，严格 null 请求后恢复同单最新完整报价', async () => {
    const f = fixture();
    f.finish(f.begin());
    await f.observer.settle();
    const previous = f.observer.nativeBilling(details);
    const item = f.begin({
      path: '/backend-api/payments/checkout/update_tax_id',
      data: { checkout_session_id: checkoutId, tax_id_info: null }
    });
    expect(f.observer.nativeBilling(details).pending).toBe(true);
    const session = response().checkout_session;
    Reflect.deleteProperty(session.checkout_state, 'taxIdInfo');
    f.finish(item, { success: true, checkout_session: session });
    await f.observer.settle();
    const latest = f.observer.nativeBilling(details);
    expect(latest).toMatchObject({ observed: true, pending: false });
    expect(latest.error).toBeUndefined();
    expect(latest.document).toEqual(previous.document);
    expect(() => f.observer.assertNativeBillingVersion(previous.version)).toThrow();
    expect(() => f.observer.assertNativeBillingVersion(latest.version)).not.toThrow();
    expect(f.observer.confirmationRequests).toBe(0);
    expect(JSON.stringify(latest.document)).not.toContain('never-retain-processor-secret');
  });
  it('缺少先前计税请求锚点，不能仅凭省略税号的成功响应核价', async () => {
    const f = fixture();
    const session = response().checkout_session;
    Reflect.deleteProperty(session.checkout_state, 'taxIdInfo');
    f.finish(
      f.begin({
        path: '/backend-api/payments/checkout/update_tax_id',
        data: { checkout_session_id: checkoutId, tax_id_info: null }
      }),
      { success: true, checkout_session: session }
    );
    await f.observer.settle();
    expect(f.observer.nativeBilling(details)).toMatchObject({
      error: 'native_billing_tax_context_unverified'
    });
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
  });
  it('先前计税税号证明失败，后续省略字段的清空回执不能清除该失败', async () => {
    const f = fixture();
    const session = response().checkout_session;
    Reflect.deleteProperty(session.checkout_state, 'taxIdInfo');
    f.finish(f.begin(), { using_automatic_tax: false, checkout_session: session });
    await f.observer.settle();
    f.finish(
      f.begin({
        path: '/backend-api/payments/checkout/update_tax_id',
        data: { checkout_session_id: checkoutId, tax_id_info: null }
      }),
      { success: true, checkout_session: session }
    );
    await f.observer.settle();
    expect(f.observer.nativeBilling(details).error).toBe(
      'native_billing_response_tax_context_unverified'
    );
    expect(f.observer.nativeBilling(details).document).toBeUndefined();
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
