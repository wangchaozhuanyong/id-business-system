import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeBrowserRestore, V2RechargeQuote } from '@apple-business/shared';
import type { V2RechargeBitBrowserLaunch, V2RechargeDetails, V2RechargePlan } from './contracts';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import { runDirectPayment } from './bitbrowser-direct-payment';

const mock = vi.hoisted(() => ({
  evaluate: vi.fn(),
  command: vi.fn(),
  close: vi.fn(),
  fill: vi.fn(),
  verifyForm: vi.fn(),
  upgrade: vi.fn(),
  verifyQuote: vi.fn(),
  nextCycle: vi.fn(),
  observer: {
    checkout: undefined as Record<string, unknown> | undefined,
    evidence: undefined as Record<string, unknown> | undefined,
    checkoutRequests: 0,
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
    cdp: { command: mock.command }
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
    if (expression === 'page:tier') return { kind: 'tier_ready' };
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
    run: () =>
      runDirectPayment(
        browser,
        launch,
        plan,
        { ...details },
        { restored, callback, confirm, unexpected, progress, attempted: () => attempted }
      )
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.observer.checkout = undefined;
  mock.observer.evidence = undefined;
  mock.observer.checkoutRequests = 0;
  mock.observer.confirmationRequests = 0;
  mock.observer.paymentStatus = 'unknown';
  mock.observer.failure = '';
  mock.observer.linkedIntent = '';
  mock.command.mockReset().mockResolvedValue({});
  mock.evaluate.mockReset();
  mock.verifyQuote.mockReset();
  mock.nextCycle.mockReset().mockResolvedValue(undefined);
  mock.upgrade.mockReset().mockResolvedValue({ status: 'synthetic_upgrade' });
});

describe('网页充值执行器原单与单次付款契约', () => {
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
    await expect(f.run()).rejects.toThrow('synthetic authorization unavailable');
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
