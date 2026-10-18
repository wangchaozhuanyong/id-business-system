import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  V2CheckoutDiagnostic,
  V2RechargeBrowserRestore,
  V2RechargeQuote
} from '@apple-business/shared';
import type { V2RechargeBitBrowserLaunch, V2RechargeDetails, V2RechargePlan } from './contracts';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import { runDirectPayment } from './bitbrowser-direct-payment';
import { directPaymentControls, startDirectPayment } from './direct-payment-task';
import type { DirectLoginHooks } from './bitbrowser-direct-login';
import { ApiError } from '@/api/apiError';

const mock = vi.hoisted(() => ({
  evaluate: vi.fn(),
  command: vi.fn(),
  close: vi.fn(),
  fill: vi.fn(),
  verifyForm: vi.fn(),
  upgrade: vi.fn(),
  verifyQuote: vi.fn(),
  nextCycle: vi.fn(),
  apiCallback: vi.fn(),
  login: vi.fn(),
  grant: vi.fn(),
  cancel: vi.fn(),
  observer: {
    checkout: undefined as Record<string, unknown> | undefined,
    evidence: undefined as Record<string, unknown> | undefined,
    stripeQuotes: new Map(),
    checkoutRequests: 0,
    checkoutFailure: undefined as
      | {
          reason: 'official_checkout_http_failed';
          http_status: number;
          diagnostics?: { checkout_error: V2CheckoutDiagnostic };
        }
      | undefined,
    confirmationRequests: 0,
    paymentStatus: 'unknown',
    failure: '',
    linkedIntent: '',
    bind: vi.fn(),
    arm: vi.fn(),
    settle: vi.fn(),
    close: vi.fn(),
    onBinding: undefined as ((binding: Record<string, unknown>) => Promise<void>) | undefined
  }
}));
vi.mock('./api', () => ({
  rechargeApi: {
    directBrowserCallback: mock.apiCallback,
    confirmDirectPayment: mock.grant,
    cancelBitBrowser: mock.cancel
  }
}));
vi.mock('./bitbrowser-direct-login', () => ({ runDirectLogin: mock.login }));
vi.mock('./bitbrowser-payment-session', () => ({
  createDirectPaymentSession: async (browser: VerifiedPaymentBrowser) => ({
    session: { signal: browser.signal, evaluate: mock.evaluate, frames: vi.fn() },
    close: mock.close,
    ownsSession: () => true
  }),
  waitDirectPayment: async () => {}
}));
vi.mock('./bitbrowser-payment-form', () => ({
  fillDirectPaymentForm: mock.fill,
  verifyDirectPaymentForm: mock.verifyForm
}));
vi.mock('./bitbrowser-payment-observer', () => ({
  DirectPaymentObserver: class {
    constructor() {
      return mock.observer;
    }
  }
}));
vi.mock('./bitbrowser-direct-upgrade', () => ({ runDirectSubscriptionUpgrade: mock.upgrade }));
vi.mock('./bitbrowser-direct-cycle', () => ({ prepareDirectNextCycle: mock.nextCycle }));
vi.mock('./bitbrowser-payment-page', () => ({
  directPaymentPageExpression: (_plan: string, action: string) => 'page:' + action
}));
vi.mock('./bitbrowser-payment-evidence', async (original) => ({
  ...(await original<typeof import('./bitbrowser-payment-evidence')>()),
  officialPaymentRead: (_identity: unknown, path: string) => 'read:' + path,
  verifyNativeDirectQuote: mock.verifyQuote
}));

const accountId = 'synthetic-account';
const accountKey = createHash('sha256').update(accountId).digest('hex');
const oldId = 'oaics_old_synthetic';
const newId = 'oaics_new_synthetic';
const entity = 'openai_llc';
const details: V2RechargeDetails = {
  number: '4242424242424242',
  expiry: '12/39',
  cvc: '123',
  name: 'Synthetic Buyer',
  email: 'buyer@example.invalid',
  country: 'US',
  line1: '123 Test Street',
  line2: '',
  city: 'Test City',
  state: 'CA',
  postal_code: '90001'
};
const quote: V2RechargeQuote = {
  plan: 'plus',
  today: { currency: 'USD', amount: '20.00', amount_minor: 2000 },
  tax: { currency: 'USD', amount: '0.00', amount_minor: 0 },
  renewal: { currency: 'USD', amount: '20.00', amount_minor: 2000 },
  renewal_interval: 'monthly'
};

function fixture(
  options: {
    plan?: V2RechargePlan;
    current?: string;
    status?: string;
    paymentStatus?: string;
    noRecord?: boolean;
    activeEntitlement?: boolean;
    billingState?: string;
  } = {}
) {
  const plan = options.plan ?? 'plus';
  let current = options.current ?? 'free';
  let pageId = oldId;
  let attempted = false;
  let recordRevision = 7;
  const events: string[] = [];
  const old = {
    checkout_session_id: oldId,
    processor_entity: entity,
    plan_name: plan === 'plus' ? 'chatgptplusplan' : 'chatgptpromax',
    status: options.status ?? 'expired',
    payment_status: options.paymentStatus ?? 'unpaid'
  };
  const restored: V2RechargeBrowserRestore = {
    records: options.noRecord
      ? []
      : [
          {
            fileKey: `${accountKey}${plan === 'plus' ? '' : '-' + plan}.json`,
            revision: 7,
            document: {
              checkout_identifier: oldId,
              processor_entity: entity,
              target_plan: plan,
              payment_attempted: false,
              payment_requests_sent: 0,
              confirmation_requests_sent: 0,
              checkout_outcome: 'created',
              payment_status: 'not_attempted'
            }
          }
        ],
    staleProfiles: []
  };
  const launch = {
    id: '11111111-1111-4111-8111-111111111111',
    mode: 'payment',
    transport: 'web_direct',
    connectorUrl: '',
    connectorToken: '',
    agentToken: 'synthetic-agent',
    bitBrowser: {},
    address: {},
    safety: { lockedCurrency: 'USD', authorizeSinglePayment: true, manualPaymentConfirmation: true }
  } as unknown as V2RechargeBitBrowserLaunch;
  const browser = {
    identity: { accountId, userId: 'synthetic-user', email: details.email, plan: current },
    profileId: 'a'.repeat(32),
    sessionId: 'owned',
    signal: new AbortController().signal,
    cdp: { command: mock.command, onClose: () => () => undefined }
  } as unknown as VerifiedPaymentBrowser;
  const callback = vi.fn(async (value: object): Promise<Record<string, unknown>> => {
    const input = value as Record<string, unknown>;
    if (input.type === 'replace_expired_checkout') {
      events.push('expired_authorized');
      return {
        replacementAuthorized: true,
        checkoutIdentifier: oldId,
        retryOf: 'a'.repeat(64),
        checkoutRecordRevision: recordRevision
      };
    }
    if (input.type === 'ledger') {
      events.push(
        (input.document as Record<string, unknown>).checkout_outcome === 'unknown'
          ? 'new_marker'
          : 'new_checkout_record'
      );
      return { revision: ++recordRevision };
    }
    throw new Error('Unexpected synthetic callback');
  });
  const confirm = vi.fn(async (_report: object, preflight: () => Promise<void>) => {
    await preflight();
    events.push('confirmation_consumed');
    attempted = true;
  });
  const progress = vi.fn(async () => {});
  const unexpected = vi.fn(async () => {});
  mock.evaluate.mockImplementation(async (expression: string) => {
    if (expression === 'read:/backend-api/accounts/check/v4-2023-04-27')
      return {
        ok: true,
        status: 200,
        data: {
          accounts: {
            [accountId]: {
              account: { account_id: accountId, plan_type: current },
              entitlement: { has_active_subscription: options.activeEntitlement ?? false }
            }
          }
        }
      };
    if (expression.startsWith('read:/backend-api/payments/checkout/'))
      return {
        ok: true,
        status: 200,
        data: expression.endsWith('/' + oldId)
          ? old
          : { ...old, checkout_session_id: newId, status: 'open' }
      };
    if (expression === 'page:prepare') return { kind: 'plan_ready' };
    if (expression === 'page:create') {
      events.push('create_clicked');
      pageId = newId;
      mock.observer.checkoutRequests++;
      mock.observer.checkout = { checkout_session_id: newId, processor_entity: entity };
      return { kind: 'submitted' };
    }
    if (expression === 'page:inspect')
      return { kind: 'page', text: 'synthetic quote', checkoutId: pageId, entity };
    if (['page:tier', 'page:verify_tier'].includes(expression)) return { kind: 'tier_ready' };
    if (expression === 'page:confirm') {
      events.push('payment_clicked');
      mock.observer.confirmationRequests = 1;
      mock.observer.evidence = {
        kind: 'payment_intent',
        identifier: 'pi_Synthetic',
        amount_minor: 2000,
        currency: 'USD'
      };
      mock.observer.paymentStatus = 'paid';
      current = 'plus';
      return { kind: 'submitted' };
    }
    throw new Error('Unexpected synthetic browser operation');
  });
  mock.verifyQuote.mockResolvedValue({ quote, billing_fingerprint: 'b'.repeat(64) });
  return {
    restored,
    callback,
    confirm,
    unexpected,
    progress,
    events,
    launch,
    browser,
    run: () =>
      runDirectPayment(
        browser,
        launch,
        plan,
        { ...details, state: options.billingState ?? details.state },
        { restored, callback, confirm, unexpected, progress, attempted: () => attempted }
      )
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.observer.checkout = undefined;
  mock.observer.checkoutFailure = undefined;
  mock.observer.evidence = undefined;
  mock.observer.checkoutRequests = 0;
  mock.observer.confirmationRequests = 0;
  mock.observer.paymentStatus = 'unknown';
  mock.observer.failure = '';
  mock.observer.linkedIntent = '';
  mock.command.mockReset().mockResolvedValue({});
  mock.evaluate.mockReset();
  mock.verifyQuote.mockReset();
  mock.fill.mockReset().mockResolvedValue({ state: details.state });
  mock.verifyForm.mockReset().mockResolvedValue({ state: details.state });
  mock.nextCycle.mockReset().mockResolvedValue(undefined);
  mock.upgrade.mockReset().mockResolvedValue({ status: 'synthetic_upgrade' });
});

describe('网页充值执行器原单与单次付款契约', () => {
  it('申请过期换单前先持久回传本轮核实的免费套餐、账号及原单绑定', async () => {
    const f = fixture();
    let persisted: Record<string, unknown> = {};
    f.progress.mockImplementation(async (_stage?: string, report: Record<string, unknown> = {}) => {
      persisted = { ...persisted, ...report };
    });
    const callback = f.callback.getMockImplementation()!;
    f.callback.mockImplementation(async (input) => {
      if ((input as Record<string, unknown>).type === 'replace_expired_checkout')
        expect(persisted).toMatchObject({
          account_matched: true,
          current_plan: 'free',
          checkout_identifier: oldId,
          processor_entity: entity,
          payment_attempted: false,
          payment_requests_sent: 0,
          confirmation_requests_sent: 0
        });
      return callback(input);
    });
    await f.run();
    expect(f.events).toContain('expired_authorized');
  });
  it('Pro 建单后档位尚在加载时继续等待；失败时仍报告已建单编号', async () => {
    const f = fixture({ plan: 'pro-5x', noRecord: true });
    const evaluate = mock.evaluate.getMockImplementation()!;
    let tiers = 0;
    mock.evaluate.mockImplementation(async (expression: string) => {
      if (['page:tier', 'page:verify_tier'].includes(expression))
        return { kind: ++tiers === 1 ? 'tier_loading' : 'ambiguous_tier' };
      return evaluate(expression);
    });
    await expect(f.run()).rejects.toThrow();
    expect(tiers).toBe(2);
    expect(f.progress).toHaveBeenLastCalledWith(
      'plan_selection',
      expect.objectContaining({
        checkout_identifier: newId,
        processor_entity: entity,
        checkout_requests_sent: 1,
        confirmation_requests_sent: 0,
        payment_attempted: false
      })
    );
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it.each(['http', 'page'])('建单%s失败保留精确诊断及原标记，不重复点击', async (kind) => {
    const f = fixture({ noRecord: true });
    const evaluate = mock.evaluate.getMockImplementation()!;
    mock.evaluate.mockImplementation(async (expression: string) => {
      const result = await evaluate(expression);
      if (expression === 'page:create') {
        mock.observer.checkout = undefined;
        if (kind === 'http')
          mock.observer.checkoutFailure = {
            reason: 'official_checkout_http_failed',
            http_status: 403,
            diagnostics: { checkout_error: { request_index: 1, body_state: 'reading' } }
          };
      }
      if (kind === 'page' && expression === 'page:inspect')
        return { kind: 'payment_form_load_failed' };
      return result;
    });
    mock.observer.settle.mockImplementationOnce(async () => {
      if (mock.observer.checkoutFailure)
        mock.observer.checkoutFailure.diagnostics = {
          checkout_error: {
            request_index: 1,
            body_state: 'parsed_json',
            code: 'invalid_request_error',
            param: 'plan_name',
            attribution: 'structured_code'
          }
        };
    });
    await expect(f.run()).rejects.toMatchObject({
      facts: {
        stage: 'checkout_create',
        reason:
          kind === 'http' ? 'official_checkout_http_failed' : 'official_payment_form_load_failed',
        ...(kind === 'http'
          ? {
              http_status: 403,
              diagnostics: {
                checkout_error: {
                  request_index: 1,
                  body_state: 'parsed_json',
                  code: 'invalid_request_error',
                  param: 'plan_name',
                  attribution: 'structured_code'
                }
              }
            }
          : { page_state: 'official_error' })
      }
    });
    expect(f.events.filter((e) => e === 'create_clicked')).toHaveLength(1);
    expect(f.events).toContain('new_marker');
    expect(f.progress).toHaveBeenLastCalledWith(
      'checkout_create',
      expect.objectContaining({
        checkout_requests_sent: 1,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      })
    );
    expect(f.confirm).not.toHaveBeenCalled();
    expect(mock.fill).not.toHaveBeenCalled();
  });
  it.each(['visible', 'delayed', 'unavailable', 'never'])(
    '建单 HTTP 400 时官网表单提示%s，保留状态码且不再次建单',
    async (pageState) => {
      const f = fixture({ noRecord: true });
      const evaluate = mock.evaluate.getMockImplementation()!;
      let inspections = 0;
      mock.evaluate.mockImplementation(async (expression: string) => {
        if (expression === 'page:inspect') {
          inspections++;
          if (pageState === 'unavailable') throw new Error('synthetic page unavailable');
          if (pageState === 'never' || (pageState === 'delayed' && inspections < 3))
            return { kind: 'page' };
          return { kind: 'payment_form_load_failed' };
        }
        const result = await evaluate(expression);
        if (expression === 'page:create') {
          mock.observer.checkout = undefined;
          mock.observer.checkoutFailure = {
            reason: 'official_checkout_http_failed',
            http_status: 400
          };
        }
        return result;
      });
      await expect(f.run()).rejects.toMatchObject({
        facts: {
          stage: 'checkout_create',
          reason: ['visible', 'delayed'].includes(pageState)
            ? 'official_payment_form_load_failed'
            : 'official_checkout_http_failed',
          http_status: 400,
          ...(['visible', 'delayed'].includes(pageState) ? { page_state: 'official_error' } : {})
        }
      });
      expect(f.events.filter((event) => event === 'create_clicked')).toHaveLength(1);
      expect(inspections).toBe(pageState === 'delayed' ? 3 : pageState === 'never' ? 6 : 1);
      expect(f.progress).toHaveBeenLastCalledWith(
        'checkout_create',
        expect.objectContaining({
          checkout_requests_sent: 1,
          payment_requests_sent: 0,
          confirmation_requests_sent: 0
        })
      );
      expect(mock.fill).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
    }
  );
  it('官网错误页检查期间到达的HTTP拒绝也保留诊断，不填卡、不确认或重新建单', async () => {
    const f = fixture({ noRecord: true });
    const evaluate = mock.evaluate.getMockImplementation()!;
    mock.evaluate.mockImplementation(async (expression: string) => {
      const result = await evaluate(expression);
      if (expression === 'page:create') mock.observer.checkout = undefined;
      if (expression === 'page:inspect') {
        mock.observer.checkoutFailure = {
          reason: 'official_checkout_http_failed',
          http_status: 400,
          diagnostics: {
            checkout_error: {
              request_index: 1,
              body_state: 'parsed_json',
              attribution: 'unclassified'
            }
          }
        };
        return { kind: 'payment_form_load_failed' };
      }
      return result;
    });
    await expect(f.run()).rejects.toMatchObject({
      facts: {
        reason: 'official_payment_form_load_failed',
        http_status: 400,
        diagnostics: {
          checkout_error: {
            request_index: 1,
            body_state: 'parsed_json',
            attribution: 'unclassified'
          }
        }
      }
    });
    expect(f.events.filter((event) => event === 'create_clicked')).toHaveLength(1);
    expect(mock.fill).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it('官网明确提示验证失败时回传该原因，同时保留内部绑定异常并禁止重付', async () => {
    const f = fixture();
    const evaluate = mock.evaluate.getMockImplementation()!;
    let submitted = false;
    mock.evaluate.mockImplementation(async (expression: string) => {
      const result = await evaluate(expression);
      if (expression === 'page:confirm') {
        submitted = true;
        mock.observer.evidence = undefined;
        mock.observer.failure = 'payment_order_binding_changed';
        mock.observer.paymentStatus = 'unknown';
      }
      return submitted && expression === 'page:inspect'
        ? { ...result, kind: 'payment_method_verification_failed' }
        : result;
    });
    expect(await f.run()).toMatchObject({
      status: 'payment_result_unknown',
      reason: 'official_payment_method_verification_failed',
      last_reason: 'payment_order_binding_changed',
      payment_requests_sent: 1,
      repeated_payment: 'blocked'
    });
    expect(f.events.filter((event) => event === 'payment_clicked')).toHaveLength(1);
  });
  it('付款观察器拒绝绑定时保留受控原因和原单，不丢为未知原因', async () => {
    const f = fixture();
    const evaluate = mock.evaluate.getMockImplementation()!;
    mock.evaluate.mockImplementation(async (expression: string) => {
      const result = await evaluate(expression);
      if (expression === 'page:confirm') {
        mock.observer.evidence = undefined;
        mock.observer.failure = 'payment_order_binding_changed';
        mock.observer.paymentStatus = 'unknown';
      }
      return result;
    });
    const result = await f.run();
    expect(result).toMatchObject({
      status: 'payment_result_unknown',
      reason: 'payment_order_binding_changed',
      payment_requests_sent: 1,
      repeated_payment: 'blocked'
    });
    expect(f.events.filter((event) => event === 'payment_clicked')).toHaveLength(1);
  });
  it('等待银行验证超时后保留本人验证提示和付款锁', async () => {
    const f = fixture();
    const evaluate = mock.evaluate.getMockImplementation()!;
    let time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    mock.evaluate.mockImplementation(async (expression: string) => {
      const result = await evaluate(expression);
      if (expression === 'page:confirm') {
        mock.observer.evidence = undefined;
        mock.observer.paymentStatus = 'requires_action';
      }
      return result;
    });
    f.progress.mockImplementation(async (stage?: string) => {
      if (stage === 'payment_human_verification') time += 120001;
    });
    try {
      expect(await f.run()).toMatchObject({
        status: 'payment_result_unknown',
        stage: 'payment_human_verification',
        reason: 'direct_payment_bank_verification_required',
        payment_status: 'requires_action',
        user_action_required: true,
        payment_requests_sent: 1,
        repeated_payment: 'blocked'
      });
      expect(f.events.filter((event) => event === 'payment_clicked')).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
  it('报价绑定官网已核实的州代码，付款前再次确认代码未改变', async () => {
    const f = fixture({ billingState: 'Oregon' });
    mock.fill.mockResolvedValue({ state: 'OR' });
    mock.verifyForm.mockResolvedValue({ state: 'OR' });
    await f.run();
    expect(mock.fill.mock.calls[0][1]).toMatchObject({ state: 'Oregon' });
    expect(mock.verifyQuote.mock.calls[0][4]).toMatchObject({ state: 'OR' });
    expect(mock.verifyForm.mock.calls[0][1]).toMatchObject({ state: 'Oregon' });
  });
  it('付款前官网州代码改变时停止，不点击付款', async () => {
    const f = fixture();
    mock.verifyForm.mockResolvedValue({ state: 'OR' });
    await expect(f.run()).rejects.toThrow();
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.observer.arm).not.toHaveBeenCalled();
  });
  it('官网标称Free但仍有有效订阅权益时不重建、不升级、不写新单标记', async () => {
    const f = fixture({ current: 'free', activeEntitlement: true });
    await expect(f.run()).rejects.toThrow();
    expect(f.callback).not.toHaveBeenCalled();
    expect(mock.nextCycle).not.toHaveBeenCalled();
    expect(mock.upgrade).not.toHaveBeenCalled();
    expect(mock.fill).not.toHaveBeenCalled();
    expect(f.events).not.toContain('create_clicked');
  });
  it('过期未付款原单先获得服务端授权，按返回revision写replacement proof后只建一次', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.status).toBe('subscription_activated');
    expect(f.events.indexOf('expired_authorized')).toBeLessThan(f.events.indexOf('new_marker'));
    expect(f.events.indexOf('new_marker')).toBeLessThan(f.events.indexOf('create_clicked'));
    expect(f.events.filter((event) => event === 'create_clicked')).toHaveLength(1);
    const marker = f.callback.mock.calls
      .map(([input]) => input as Record<string, unknown>)
      .find((input) => input.type === 'ledger');
    expect(marker).toMatchObject({
      revision: 7,
      document: {
        retry_of: 'a'.repeat(64),
        expired_checkout_replacement: {
          checkout_identifier: oldId,
          processor_entity: entity,
          target_plan: 'plus',
          account_key: accountKey,
          status: 'expired',
          payment_status: 'unpaid'
        }
      }
    });
    expect(f.events.filter((event) => event === 'payment_clicked')).toHaveLength(1);
    expect(mock.observer.arm).toHaveBeenCalledOnce();
  });
  it.each([
    {
      replacementAuthorized: false,
      checkoutIdentifier: oldId,
      retryOf: 'a'.repeat(64),
      checkoutRecordRevision: 8
    },
    { replacementAuthorized: true, checkoutIdentifier: oldId, checkoutRecordRevision: 8 },
    {
      replacementAuthorized: true,
      checkoutIdentifier: oldId,
      retryOf: 'invalid',
      checkoutRecordRevision: 8
    },
    { replacementAuthorized: true, checkoutIdentifier: oldId, retryOf: 'a'.repeat(64) },
    {
      replacementAuthorized: true,
      checkoutIdentifier: 'oaics_other',
      retryOf: 'a'.repeat(64),
      checkoutRecordRevision: 8
    },
    {
      replacementAuthorized: true,
      checkoutIdentifier: oldId,
      retryOf: 'a'.repeat(64),
      checkoutRecordRevision: -1
    },
    {
      replacementAuthorized: true,
      checkoutIdentifier: oldId,
      retryOf: 'a'.repeat(64),
      checkoutRecordRevision: 0
    },
    {
      replacementAuthorized: true,
      checkoutIdentifier: oldId,
      retryOf: 'a'.repeat(64),
      checkoutRecordRevision: 6
    }
  ])('过期替换授权不完整或无效时不写新标记、不建单 %o', async (grant) => {
    const f = fixture();
    f.callback.mockResolvedValueOnce(grant);
    await expect(f.run()).rejects.toThrow();
    expect(f.events).not.toContain('create_clicked');
    expect(
      f.callback.mock.calls.some(([input]) => (input as Record<string, unknown>).type === 'ledger')
    ).toBe(false);
    expect(mock.fill).not.toHaveBeenCalled();
  });
  it('服务端拒绝替换或响应丢失时不重发授权、不建单', async () => {
    const f = fixture();
    f.callback.mockRejectedValueOnce(new Error('synthetic authorization unavailable'));
    await expect(f.run()).rejects.toMatchObject({
      facts: {
        stage: 'expired_checkout_authorization',
        reason: 'direct_payment_expired_authorization_failed'
      }
    });
    expect(f.callback).toHaveBeenCalledOnce();
    expect(f.events).not.toContain('create_clicked');
  });
  it.each([
    { status: 'expired', paymentStatus: 'paid' },
    { status: 'complete', paymentStatus: 'unpaid' }
  ])('未确认expired+unpaid不能替换 %o', async (options) => {
    const f = fixture(options);
    await expect(f.run()).rejects.toThrow();
    expect(f.callback).not.toHaveBeenCalled();
    expect(f.events).not.toContain('create_clicked');
  });
  it.each([
    { payment_attempted: false, payment_status: 'not_attempted' },
    { payment_attempted: true, payment_status: 'unknown' },
    { payment_attempted: false, confirmation_requests_sent: 1, payment_status: 'not_attempted' },
    { payment_attempted: false, payment_requests_sent: 1, payment_status: 'not_attempted' },
    {
      payment_attempted: true,
      payment_status: 'paid',
      status: 'paid_pending_activation',
      payment_evidence: { kind: 'payment_intent' }
    }
  ])('另一档历史付款或升级未核实前，不能进入新升级 %o', async (history) => {
    const f = fixture({ plan: 'pro-500', current: 'plus', noRecord: true });
    f.restored.records.push({
      fileKey: 'payments/' + 'c'.repeat(64) + '.json',
      revision: 3,
      document: {
        operation: 'subscription_upgrade',
        upgrade_identifier: 'upg_' + 'd'.repeat(32),
        target_plan: 'pro-20x',
        ...history
      }
    });
    await expect(f.run()).rejects.toThrow();
    expect(mock.upgrade).not.toHaveBeenCalled();
    expect(f.events).not.toContain('create_clicked');
  });
  it('服务端恢复了原单编号但原单文档缺失时不新建', async () => {
    const f = fixture({ noRecord: true });
    f.restored.originalCheckoutIdentifier = oldId;
    await expect(f.run()).rejects.toThrow();
    expect(f.events).not.toContain('create_clicked');
    expect(f.callback).not.toHaveBeenCalled();
  });
  it('人工确认消费返回后报价变动，仍须再次核价并禁止点击付款', async () => {
    const f = fixture();
    f.confirm.mockImplementationOnce(async (_report, preflight) => {
      await preflight();
      f.events.push('confirmation_consumed');
      mock.verifyQuote.mockResolvedValue({
        quote: { ...quote, today: { currency: 'USD', amount: '21.00', amount_minor: 2100 } },
        billing_fingerprint: 'b'.repeat(64)
      });
    });
    await expect(f.run()).rejects.toThrow('账单资料或官网报价已变化');
    expect(f.events).toContain('confirmation_consumed');
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.observer.arm).not.toHaveBeenCalled();
  });
});

describe('真实网页任务入口的失败回传诊断', () => {
  it.each(['http', 'binding', 'authorization', 'private-error'] as const)(
    '原单%s失败保留实际停点，未付款且不导航或创建新单',
    async (failure) => {
      const f = fixture();
      const evaluate = mock.evaluate.getMockImplementation()!;
      mock.evaluate.mockImplementation(async (expression: string) => {
        if (expression.startsWith('read:/backend-api/payments/checkout/')) {
          if (failure === 'http') return { ok: false, status: 410 };
          if (failure === 'private-error')
            throw new Error('synthetic-private-token 4242424242424242');
          if (failure === 'binding')
            return {
              ok: true,
              status: 200,
              data: {
                checkout_session_id: oldId,
                processor_entity: entity,
                plan_name: 'other-plan',
                status: 'expired',
                payment_status: 'unpaid'
              }
            };
        }
        return evaluate(expression);
      });
      mock.apiCallback.mockImplementation(async (_id, _token, body) => {
        if (body.type === 'restore') return f.restored;
        if (body.type === 'replace_expired_checkout')
          throw new ApiError('synthetic-private-rejection', {
            kind: 'conflict',
            code: 'CONFLICT',
            status: 409,
            retryable: false
          });
        return { ok: true };
      });
      mock.login.mockImplementation(
        async (_settings, _credential, _name, _signal, hooks: DirectLoginHooks) => {
          await hooks.restore!(accountKey);
          return hooks.ready!(f.browser);
        }
      );
      await startDirectPayment({
        launch: f.launch,
        plan: 'plus',
        credential: { sessionJson: 'synthetic-private-credential' },
        payment: { ...details },
        windowName: '合成诊断',
        signal: f.browser.signal,
        refresh: vi.fn().mockResolvedValue(undefined),
        reportError: vi.fn()
      });
      await vi.waitFor(() => expect(directPaymentControls.has(f.launch.id)).toBe(false));
      const result = mock.apiCallback.mock.calls.find(([, , body]) => body.type === 'finished')?.[2]
        .result;
      const stage =
        failure === 'binding'
          ? 'existing_checkout_binding'
          : failure === 'authorization'
            ? 'expired_checkout_authorization'
            : 'existing_checkout_read';
      const reason =
        failure === 'binding'
          ? 'existing_checkout_unverified'
          : failure === 'authorization'
            ? 'direct_payment_expired_authorization_failed'
            : 'direct_payment_existing_checkout_read_failed';
      expect(result).toMatchObject({
        stage,
        reason,
        status: 'blocked',
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      });
      if (failure === 'http' || failure === 'authorization')
        expect(result.http_status).toBe(failure === 'http' ? 410 : 409);
      expect(JSON.stringify(result)).not.toMatch(/synthetic-private|4242424242424242/);
      expect(mock.command.mock.calls.some(([name]) => name === 'Page.navigate')).toBe(false);
      expect(f.events).not.toContain('create_clicked');
      expect(mock.grant).not.toHaveBeenCalled();
      expect(mock.fill).not.toHaveBeenCalled();
    }
  );
  it.each(['read', 'validation', 'form'] as const)(
    '付款准备%s失败不会被统一覆盖为quote_read',
    async (failure) => {
      const f = fixture({ status: 'open' });
      if (failure === 'form')
        mock.fill.mockRejectedValueOnce(new Error('official_payment_field_not_ready'));
      if (failure === 'validation')
        mock.verifyQuote.mockRejectedValue(new Error('官网付款币种与锁定币种不一致。'));
      if (failure === 'read') {
        const evaluate = mock.evaluate.getMockImplementation()!;
        let reads = 0;
        mock.evaluate.mockImplementation(async (expression: string) => {
          if (expression.startsWith('read:/backend-api/payments/checkout/') && ++reads > 1)
            return { ok: false, status: 502 };
          return evaluate(expression);
        });
      }
      const stage =
        failure === 'form'
          ? 'payment_preparation'
          : failure === 'read'
            ? 'quote_read'
            : 'quote_validation';
      const reason =
        failure === 'form'
          ? 'official_payment_field_not_ready'
          : failure === 'read'
            ? 'direct_payment_quote_read_failed'
            : 'payment_currency_mismatch';
      await expect(f.run()).rejects.toMatchObject({ facts: { stage, reason } });
      expect(f.progress).toHaveBeenLastCalledWith(
        stage,
        expect.objectContaining({ stage, reason, payment_requests_sent: 0 })
      );
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.events).not.toContain('payment_clicked');
      if (failure === 'validation') expect(mock.verifyQuote).toHaveBeenCalledTimes(3);
    }
  );
});

describe('owned unidentified checkout recovery', () => {
  function recovery(options: Parameters<typeof fixture>[0] = {}) {
    const f = fixture({ status: 'open', ...options });
    f.restored.unidentifiedCheckoutRecovery = true;
    f.restored.ownedProfile = {
      accountKey,
      profileId: f.browser.profileId,
      sourceJobId: 'synthetic-source'
    };
    (f.restored.records[0] as { document: object }).document = {
      status: 'checkout_attempted',
      stage: 'checkout_create',
      checkout_outcome: 'unknown',
      payment_status: 'not_attempted'
    };
    return f;
  }
  it('reads and persists the owned open unpaid checkout, then reaches the existing quote hold with no new checkout', async () => {
    const f = recovery();
    f.confirm.mockImplementation(async () => {
      throw new Error('synthetic prepayment hold');
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ledger',
        document: expect.objectContaining({
          checkout_identifier: oldId,
          checkout_recovered_from_original: true,
          payment_requests_sent: 0
        })
      })
    );
    expect(mock.fill).toHaveBeenCalledOnce();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.events).not.toContain('create_clicked');
    expect(f.events).not.toContain('payment_clicked');
  });
  it.each([
    'expired',
    'paid',
    'profile',
    'account',
    'missing-record',
    'no-candidate',
    'wrong-plan',
    'new-request'
  ])('stops %s before fill, creation or confirmation', async (kind) => {
    const f = recovery({
      status: kind === 'expired' ? 'expired' : 'open',
      paymentStatus: kind === 'paid' ? 'paid' : 'unpaid'
    });
    if (kind === 'profile') f.restored.ownedProfile!.profileId = 'f'.repeat(32);
    if (kind === 'account') f.restored.ownedProfile!.accountKey = 'f'.repeat(64);
    if (kind === 'missing-record') f.restored.records = [];
    const read = mock.evaluate.getMockImplementation()!;
    if (kind === 'no-candidate' || kind === 'wrong-plan')
      mock.evaluate.mockImplementation(async (expression: string) => {
        if (kind === 'no-candidate' && expression === 'page:inspect') return { kind: 'page' };
        const result = await read(expression);
        if (kind === 'wrong-plan' && expression.startsWith('read:/backend-api/payments/checkout/'))
          result.data.plan_name = 'chatgptgoplan';
        return result;
      });
    if (kind === 'new-request') mock.observer.checkoutRequests = 1;
    await expect(f.run()).rejects.toThrow();
    expect(mock.fill).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.events).not.toContain('create_clicked');
    expect(f.events).not.toContain('payment_clicked');
    expect(f.callback).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'replace_expired_checkout' })
    );
  });
});
