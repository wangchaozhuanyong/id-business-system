import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { directPaymentDocumentDigest } from './bitbrowser-payment-evidence';
import type { NativeBillingObservation } from './bitbrowser-native-quote';

const mock = vi.hoisted(() => ({
  evaluate: vi.fn(),
  pageExpression: vi.fn<
    (
      plan: string,
      action: string,
      checkout?: string,
      preparation?: { menuRequested: boolean; personalRequested: boolean }
    ) => string
  >((_plan, action) => 'page:' + action),
  command: vi.fn(),
  close: vi.fn(),
  fill: vi.fn(),
  verifyForm: vi.fn(),
  wait: vi.fn(),
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
    trackNativeBilling: vi.fn(),
    nativeBilling: vi.fn<() => NativeBillingObservation>(),
    assertNativeBillingVersion: vi.fn(),
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
  waitDirectPayment: mock.wait
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
  directPaymentPageExpression: mock.pageExpression
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
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mock.wait.mockReset().mockImplementation(async (_signal: AbortSignal, ms = 200) => {
    now += ms;
  });
  mock.observer.nativeBilling.mockReset().mockReturnValue({
    version: 0,
    pending: false,
    observed: false,
    changedAt: 0
  });
  mock.observer.assertNativeBillingVersion.mockReset();
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
afterEach(() => vi.restoreAllMocks());

describe('原生结账的当前账单计税屏障', () => {
  const nativeDocument = { checkout_session_id: newId, synthetic_latest_tax_response: true };
  const nativeState = (overrides: Partial<NativeBillingObservation> = {}) => ({
    version: 2,
    observed: true,
    pending: false,
    changedAt: 0,
    document: nativeDocument,
    ...overrides
  });
  it('旧GET账单不同，等待迟到且已完成的当前税响应后才完成核价', async () => {
    const f = fixture();
    const started = Date.now();
    const wait = mock.wait.getMockImplementation()!;
    let state: NativeBillingObservation = nativeState({
      version: 1,
      observed: false,
      document: undefined
    });
    mock.observer.nativeBilling.mockImplementation(() => state);
    mock.observer.assertNativeBillingVersion.mockImplementation((version: number) => {
      if (state.version !== version || state.pending) throw new Error('billing_fields_changed');
    });
    mock.wait.mockImplementation(async (signal: AbortSignal, ms = 200) => {
      await wait(signal, ms);
      const elapsed = Date.now() - started;
      if (elapsed >= 1600) state = nativeState({ changedAt: started + 1300 });
      else if (elapsed >= 1300)
        state = nativeState({ pending: true, document: undefined, changedAt: started + 1300 });
    });
    mock.verifyQuote.mockImplementation(async (data) => {
      if (data !== nativeDocument) throw new Error('official_billing_line1_mismatch');
      return { quote, billing_fingerprint: 'b'.repeat(64) };
    });
    f.confirm.mockRejectedValueOnce(new Error('synthetic_stop_before_payment'));
    await expect(f.run()).rejects.toThrow();
    expect(mock.observer.trackNativeBilling).toHaveBeenCalledWith(newId, entity, 'plus', 'USD');
    expect(mock.verifyQuote.mock.calls[0]?.[0]).not.toBe(nativeDocument);
    expect(mock.verifyQuote.mock.lastCall?.[0]).toBe(nativeDocument);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2050);
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.observer.arm).not.toHaveBeenCalled();
  });
  it('完全没有当前税响应时，旧GET账单不一致仍拒绝，不能以可见表单代替', async () => {
    const f = fixture();
    mock.verifyQuote.mockRejectedValue(new Error('official_billing_line1_mismatch'));
    await expect(f.run()).rejects.toThrow('地址第一行');
    expect(mock.verifyQuote).toHaveBeenCalledTimes(3);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.observer.confirmationRequests).toBe(0);
  });
  it.each([
    { pending: true, document: undefined },
    { document: undefined, error: 'native_billing_response_address_mismatch' },
    { error: 'native_billing_request_email_mismatch' }
  ])('已出现但未核实的更新不回退到GET：%o', async (observation) => {
    const f = fixture();
    mock.observer.nativeBilling.mockReturnValue(nativeState(observation));
    await expect(f.run()).rejects.toThrow();
    expect(mock.verifyQuote).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.observer.confirmationRequests).toBe(0);
  });
  it('税响应正确仍须独立核对GET订单的当前套餐和未付款状态', async () => {
    const f = fixture();
    const evaluate = mock.evaluate.getMockImplementation()!;
    mock.observer.nativeBilling.mockReturnValue(nativeState());
    mock.evaluate.mockImplementation(async (expression: string) => {
      if (expression === `read:/backend-api/payments/checkout/${entity}/${newId}`)
        return {
          ok: true,
          status: 200,
          data: {
            checkout_session_id: newId,
            processor_entity: entity,
            plan_name: 'chatgptplusplan',
            status: 'open',
            payment_status: 'paid'
          }
        };
      return evaluate(expression);
    });
    await expect(f.run()).rejects.toThrow();
    expect(mock.verifyQuote).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.events).not.toContain('payment_clicked');
  });
  it('人工确认返回后出现新的地址更新，即使金额相同也使原确认失效', async () => {
    const f = fixture();
    let state = nativeState();
    mock.observer.nativeBilling.mockImplementation(() => state);
    mock.observer.assertNativeBillingVersion.mockImplementation((version: number) => {
      if (state.version !== version || state.pending) throw new Error('billing_fields_changed');
    });
    f.confirm.mockImplementationOnce(async (_report, preflight) => {
      await preflight();
      f.events.push('confirmation_consumed');
      state = nativeState({ version: 3, pending: true, document: undefined });
    });
    await expect(f.run()).rejects.toThrow('账单资料已变化');
    expect(f.events).toContain('confirmation_consumed');
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.observer.confirmationRequests).toBe(0);
    expect(mock.observer.arm).not.toHaveBeenCalled();
  });
  it('采样表单和GET期间到达新更新，不接受采样前的旧版本', async () => {
    const f = fixture();
    const started = Date.now();
    const wait = mock.wait.getMockImplementation()!;
    let state = nativeState({ version: 1 });
    let changed = false;
    mock.observer.nativeBilling.mockImplementation(() => state);
    mock.observer.assertNativeBillingVersion.mockImplementation((version: number) => {
      if (state.version !== version || state.pending) throw new Error('billing_fields_changed');
    });
    mock.verifyForm.mockImplementation(async () => {
      if (!changed) {
        changed = true;
        state = nativeState({
          version: 2,
          pending: true,
          document: undefined,
          changedAt: Date.now()
        });
      }
      return { state: details.state };
    });
    mock.wait.mockImplementation(async (signal: AbortSignal, ms = 200) => {
      await wait(signal, ms);
      if (changed && Date.now() - started >= 1600)
        state = nativeState({ version: 2, changedAt: started + 800 });
    });
    f.confirm.mockRejectedValueOnce(new Error('synthetic_stop_before_payment'));
    await expect(f.run()).rejects.toThrow();
    expect(mock.verifyQuote).toHaveBeenCalledOnce();
    expect(mock.observer.assertNativeBillingVersion).toHaveBeenCalledWith(1);
    expect(mock.observer.assertNativeBillingVersion).toHaveBeenCalledWith(2);
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.events).not.toContain('payment_clicked');
  });
});

describe('套餐准备动作只触发一次并等待迟到状态', () => {
  it('多轮等待保持动作标记，迟到页面就绪后只建单一次并停在付款前', async () => {
    const f = fixture({ noRecord: true });
    const evaluate = mock.evaluate.getMockImplementation()!;
    let reads = 0;
    const actions: string[] = [];
    mock.evaluate.mockImplementation(async (expression: string) => {
      if (expression !== 'page:prepare') return evaluate(expression);
      reads++;
      const preparation = mock.pageExpression.mock.lastCall?.[3] as
        | { menuRequested: boolean; personalRequested: boolean }
        | undefined;
      if (!preparation?.menuRequested) {
        actions.push('open_menu');
        return { kind: 'menu_opened', preparationAction: 'open_menu' };
      }
      if (reads < 4) return { kind: 'preparation_waiting' };
      if (!preparation.personalRequested) {
        actions.push('select_personal');
        return { kind: 'menu_opened', preparationAction: 'select_personal' };
      }
      return { kind: reads < 8 ? 'preparation_waiting' : 'plan_ready' };
    });
    f.confirm.mockRejectedValueOnce(new Error('synthetic_stop_before_payment'));
    await expect(f.run()).rejects.toThrow();
    expect(reads).toBe(8);
    expect(actions).toEqual(['open_menu', 'select_personal']);
    expect(f.events.filter((event) => event === 'create_clicked')).toHaveLength(1);
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.observer.confirmationRequests).toBe(0);
    expect(mock.observer.arm).not.toHaveBeenCalled();
    expect(mock.pageExpression.mock.calls.filter((call) => call[1] === 'prepare')[0]?.[3]).toEqual({
      menuRequested: false,
      personalRequested: false
    });
  });
  it('迟到状态始终未完成时沿用原120秒预算，且不建单或付款', async () => {
    const f = fixture({ noRecord: true });
    const evaluate = mock.evaluate.getMockImplementation()!;
    let time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    const actions: string[] = [];
    let reads = 0;
    mock.evaluate.mockImplementation(async (expression: string) => {
      if (expression !== 'page:prepare') return evaluate(expression);
      reads++;
      time += 20_000;
      const preparation = mock.pageExpression.mock.lastCall?.[3] as
        | { menuRequested: boolean; personalRequested: boolean }
        | undefined;
      if (!preparation?.menuRequested) {
        actions.push('open_menu');
        return { kind: 'menu_opened', preparationAction: 'open_menu' };
      }
      if (!preparation.personalRequested) {
        actions.push('select_personal');
        return { kind: 'menu_opened', preparationAction: 'select_personal' };
      }
      return { kind: 'preparation_waiting' };
    });
    try {
      await expect(f.run()).rejects.toThrow();
      expect(reads).toBe(6);
      expect(actions).toEqual(['open_menu', 'select_personal']);
      expect(f.callback).not.toHaveBeenCalled();
      expect(f.events).not.toContain('create_clicked');
      expect(f.events).not.toContain('payment_clicked');
      expect(mock.fill).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
      expect(mock.observer.checkoutRequests + mock.observer.confirmationRequests).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('人工核实或官网明确拒付原单后的正常入口', () => {
  const resolution = {
    operator_resolution: 'confirmed_verification_failed_no_charge',
    resolution_basis: 'operator_observed_official_failure',
    resolution_job_id: '22222222-2222-4222-8222-222222222222',
    source_job_id: '33333333-3333-4333-8333-333333333333',
    verification_job_id: '44444444-4444-4444-8444-444444444444',
    resolved_at: '2026-10-18T12:00:00.000Z'
  };
  function history(plan: V2RechargePlan) {
    const payment = {
      ...resolution,
      account_key: accountKey,
      target_plan: plan,
      checkout_identifier: oldId,
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      payment_status: 'unknown'
    };
    const checkout = {
      ...resolution,
      target_plan: plan,
      checkout_identifier: oldId,
      processor_entity: entity,
      checkout_outcome: 'created',
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0,
      payment_status: 'not_attempted'
    };
    return {
      checkout: {
        fileKey: `${accountKey}${plan === 'plus' ? '' : '-' + plan}.json`,
        revision: 7,
        document: checkout
      },
      payment: {
        fileKey: `payments/${createHash('sha256').update(oldId).digest('hex')}.json`,
        revision: 4,
        document: payment
      }
    };
  }
  function officialHistory(plan: V2RechargePlan) {
    const previous = history(plan);
    const proof = {
      kind: 'bound_payment_intent_declined',
      sourceJobId: resolution.source_job_id,
      accountKey,
      checkoutIdentifier: oldId,
      paymentIntentIdentifier: 'pi_SyntheticDecline',
      plan,
      confirmedAt: '2026-10-19T00:00:00.000Z'
    };
    for (const item of [previous.checkout, previous.payment]) {
      const document = item.document as Record<string, unknown>;
      for (const key of Object.keys(resolution)) delete document[key];
      document._official_terminal_failure_v1 = { ...proof };
    }
    previous.payment.document.payment_status = 'declined';
    return previous;
  }
  async function stopAtFinalQuote(f: ReturnType<typeof fixture>) {
    // The confirmation hook displays the quote; no payment authorization endpoint is invoked.
    f.confirm.mockImplementationOnce(async () => {
      throw new Error('synthetic_stop_before_confirmation');
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        final_quote_verified: true,
        checkout_identifier: newId,
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      }),
      expect.any(Function)
    );
    expect(mock.fill).toHaveBeenCalledOnce();
    expect(mock.verifyQuote).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event === 'create_clicked')).toHaveLength(1);
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.observer.arm).not.toHaveBeenCalled();
    expect(mock.observer.confirmationRequests).toBe(0);
    expect(mock.grant).not.toHaveBeenCalled();
  }
  it.each(['go', 'plus'] as const)(
    '官网明确拒付的%s原单允许正常创建Plus并核价，零付款且不回传私有证明',
    async (plan) => {
      const f = fixture({ noRecord: plan !== 'plus' });
      const previous = officialHistory(plan);
      f.restored.records = [previous.checkout, previous.payment];
      const before = JSON.stringify(f.restored.records);
      await stopAtFinalQuote(f);
      expect(JSON.stringify(f.restored.records)).toBe(before);
      const marker = f.callback.mock.calls[0]![0] as {
        revision: number;
        document: Record<string, unknown>;
      };
      expect(marker.revision).toBe(plan === 'plus' ? 7 : 0);
      expect(marker.document.retry_of).toBe(
        plan === 'plus' ? await directPaymentDocumentDigest(previous.checkout.document) : undefined
      );
      for (const [command] of f.callback.mock.calls) {
        const document = (command as { document: Record<string, unknown> }).document;
        expect(Object.keys(document).some((key) => key.startsWith('_'))).toBe(false);
      }
    }
  );
  it.each([
    'missing-proof',
    'requires-action',
    'duplicate-payment',
    'missing-root',
    'different-proof',
    'changed-count'
  ])('官网拒付历史%s仍在建单与填卡前停止', async (kind) => {
    const f = fixture();
    const previous = officialHistory('plus');
    const payment = previous.payment.document as Record<string, unknown>;
    const checkout = previous.checkout.document as Record<string, unknown>;
    f.restored.records = [previous.checkout, previous.payment];
    if (kind === 'missing-proof') delete payment._official_terminal_failure_v1;
    if (kind === 'requires-action') payment.payment_status = 'requires_action';
    if (kind === 'duplicate-payment') f.restored.records.push({ ...previous.payment });
    if (kind === 'missing-root') f.restored.records = [previous.payment];
    if (kind === 'different-proof')
      checkout._official_terminal_failure_v1 = {
        ...(checkout._official_terminal_failure_v1 as Record<string, unknown>),
        sourceJobId: '55555555-5555-4555-8555-555555555555'
      };
    if (kind === 'changed-count') payment.payment_requests_sent = 2;
    const before = JSON.stringify(f.restored.records);
    await expect(f.run()).rejects.toThrow();
    expect(f.callback).not.toHaveBeenCalled();
    expect(f.events).not.toContain('create_clicked');
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.fill).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(JSON.stringify(f.restored.records)).toBe(before);
  });
  it('官网明确拒付的新建标记CAS失败时不点击建单，不重试', async () => {
    const f = fixture();
    const previous = officialHistory('plus');
    f.restored.records = [previous.checkout, previous.payment];
    f.callback.mockRejectedValueOnce(new Error('synthetic CAS conflict'));
    await expect(f.run()).rejects.toThrow();
    expect(f.callback).toHaveBeenCalledOnce();
    expect(f.events).not.toContain('create_clicked');
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.fill).not.toHaveBeenCalled();
  });
  it.each([
    ['go', 'plus'],
    ['plus', 'pro-5x'],
    ['plus', 'pro-20x'],
    ['plus', 'pro-500']
  ] as const)(
    '%s升级%s的明确拒付结束后可进入原有升级流程，不重新写旧订阅checkout',
    async (source, target) => {
      const f = fixture({ current: source, plan: target, noRecord: true });
      const previous = officialHistory(target);
      const reference = 'upg_' + 'b'.repeat(32);
      const payment = previous.payment.document as Record<string, unknown>;
      const proof = payment._official_terminal_failure_v1 as Record<string, unknown>;
      delete payment.checkout_identifier;
      Object.assign(payment, {
        operation: 'subscription_upgrade',
        current_plan_before: source,
        upgrade_identifier: reference,
        _official_terminal_failure_v1: { ...proof, checkoutIdentifier: reference }
      });
      previous.payment.fileKey = `payments/${createHash('sha256').update(reference).digest('hex')}.json`;
      f.restored.records = [previous.payment];
      const before = JSON.stringify(f.restored.records);
      await expect(f.run()).resolves.toMatchObject({ status: 'synthetic_upgrade' });
      expect(mock.upgrade).toHaveBeenCalledOnce();
      expect(f.callback).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
      expect(mock.grant).not.toHaveBeenCalled();
      expect(f.events).not.toContain('payment_clicked');
      expect(JSON.stringify(f.restored.records)).toBe(before);
    }
  );
  it('Go已人工核实后可从正常入口创建Plus并完成最终核价，不改Go账本且零付款确认', async () => {
    const f = fixture({ noRecord: true });
    const previous = history('go');
    f.restored.records.push(previous.checkout, previous.payment);
    const before = JSON.stringify(f.restored.records);
    await stopAtFinalQuote(f);
    expect(JSON.stringify(f.restored.records)).toBe(before);
    expect(
      f.callback.mock.calls.every(([input]) => 'type' in input && input.type === 'ledger')
    ).toBe(true);
    expect(f.callback.mock.calls[0]![0]).toMatchObject({
      revision: 0,
      fileKey: `${accountKey}.json`,
      document: { status: 'checkout_attempted', target_plan: 'plus' }
    });
    const marker = f.callback.mock.calls[0]![0] as { document: Record<string, unknown> };
    expect(marker.document.retry_of).toBeUndefined();
  });
  it('同套餐按绑定的人工核实原单写新CAS标记后只建一张新单，旧revision和付款事实保留', async () => {
    const f = fixture({ status: 'open' });
    const previous = history('plus');
    f.restored.records = [previous.checkout, previous.payment];
    f.restored.originalCheckoutIdentifier = oldId;
    const before = JSON.stringify(f.restored.records);
    const retryOf = await directPaymentDocumentDigest(previous.checkout.document);
    const save = f.callback.getMockImplementation()!;
    f.callback.mockImplementation(async (input) => {
      const command = input as Record<string, unknown>;
      const document = command.document as Record<string, unknown> | undefined;
      if (command.type === 'ledger' && document?.status === 'checkout_attempted') {
        // Match the real server CAS contract; a transport mock must not approve an unbound marker.
        expect(command.revision).toBe(previous.checkout.revision);
        expect(document.account_key).toBe(accountKey);
        expect(document.retry_of).toBe(retryOf);
        expect(document.target_plan).toBe(previous.checkout.document.target_plan);
      }
      return save(input);
    });
    await stopAtFinalQuote(f);
    expect(JSON.stringify(f.restored.records)).toBe(before);
    expect(f.events.indexOf('new_marker')).toBeLessThan(f.events.indexOf('create_clicked'));
    const marker = f.callback.mock.calls[0]![0] as { document: Record<string, unknown> };
    expect(marker).toMatchObject({
      type: 'ledger',
      fileKey: `${accountKey}.json`,
      revision: 7,
      document: {
        status: 'checkout_attempted',
        stage: 'checkout_create',
        checkout_outcome: 'unknown',
        payment_status: 'not_attempted',
        account_key: accountKey,
        retry_of: retryOf
      }
    });
    expect(marker.document).not.toHaveProperty('operator_resolution');
    expect(marker.document).not.toHaveProperty('checkout_identifier');
    expect(marker.document).not.toHaveProperty('expired_checkout_replacement');
    expect(f.events).not.toContain('expired_authorized');
  });
  it('新CAS标记被拒绝后不点击建单、不重发，也不改写原付款账本', async () => {
    const f = fixture();
    const previous = history('plus');
    f.restored.records = [previous.checkout, previous.payment];
    const before = JSON.stringify(f.restored.records);
    f.callback.mockRejectedValueOnce(new Error('synthetic CAS conflict'));
    await expect(f.run()).rejects.toThrow();
    expect(f.callback).toHaveBeenCalledOnce();
    expect(f.events).not.toContain('create_clicked');
    expect(mock.observer.checkoutRequests).toBe(0);
    expect(mock.fill).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(JSON.stringify(f.restored.records)).toBe(before);
  });
  it.each([
    'missing-marker',
    'wrong-account',
    'wrong-file',
    'duplicate-row',
    'wrong-basis',
    'invalid-resolution',
    'two-requests',
    'missing-counters',
    'paid-evidence',
    'other-unknown'
  ])('不同套餐遇到%s仍在新建/填卡/确认前停止', async (kind) => {
    const f = fixture({ noRecord: true });
    const previous = history('go');
    f.restored.records = [previous.checkout, previous.payment];
    const payment = previous.payment.document as Record<string, unknown>;
    if (kind === 'missing-marker') delete payment.operator_resolution;
    else if (kind === 'wrong-account') payment.account_key = 'f'.repeat(64);
    else if (kind === 'wrong-file') previous.payment.fileKey = `payments/${'f'.repeat(64)}.json`;
    else if (kind === 'duplicate-row') f.restored.records.push({ ...previous.payment });
    else if (kind === 'wrong-basis') payment.resolution_basis = 'untrusted';
    else if (kind === 'invalid-resolution') payment.resolution_job_id = 'not-a-uuid';
    else if (kind === 'two-requests') payment.payment_requests_sent = 2;
    else if (kind === 'missing-counters') {
      delete payment.payment_attempted;
      delete payment.payment_requests_sent;
      delete payment.confirmation_requests_sent;
    } else if (kind === 'paid-evidence') payment.payment_evidence = { identifier: 'pi_Paid' };
    else
      f.restored.records.push({
        fileKey: `payments/${'e'.repeat(64)}.json`,
        revision: 1,
        document: {
          account_key: accountKey,
          checkout_identifier: 'oaics_other_unknown',
          target_plan: 'pro-20x',
          payment_attempted: true,
          payment_requests_sent: 1,
          confirmation_requests_sent: 1,
          payment_status: 'unknown'
        }
      });
    const before = JSON.stringify(f.restored.records);
    await expect(f.run()).rejects.toThrow();
    expect(f.callback).not.toHaveBeenCalled();
    expect(mock.fill).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.events).not.toContain('create_clicked');
    expect(f.events).not.toContain('payment_clicked');
    expect(JSON.stringify(f.restored.records)).toBe(before);
  });
  it.each(['missing-root', 'wrong-source', 'wrong-verification', 'wrong-checkout', 'bad-revision'])(
    '同套餐%s无法确认完整绑定时不放宽新建',
    async (kind) => {
      const f = fixture();
      const previous = history('plus');
      f.restored.records =
        kind === 'missing-root' ? [previous.payment] : [previous.checkout, previous.payment];
      const checkout = previous.checkout.document as Record<string, unknown>;
      if (kind === 'wrong-source') checkout.source_job_id = '55555555-5555-4555-8555-555555555555';
      if (kind === 'wrong-verification')
        checkout.verification_job_id = '55555555-5555-4555-8555-555555555555';
      if (kind === 'wrong-checkout') checkout.checkout_identifier = 'oaics_unmatched';
      if (kind === 'bad-revision') previous.checkout.revision = 0;
      await expect(f.run()).rejects.toThrow();
      expect(f.callback).not.toHaveBeenCalled();
      expect(f.events).not.toContain('create_clicked');
      expect(mock.fill).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
    }
  );
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

describe('真实runner与task新建标记ACK边界', () => {
  function setup(
    options: {
      resolved?: boolean;
      refusal?: boolean;
      ackFailure?: 'reject' | 'revision';
      paymentObserved?: boolean;
    } = {}
  ) {
    const f = fixture();
    if (options.resolved) {
      const row = f.restored.records[0] as { document: Record<string, unknown> };
      const resolution = {
        operator_resolution: 'confirmed_verification_failed_no_charge',
        resolution_basis: 'operator_observed_official_failure',
        resolution_job_id: '22222222-2222-4222-8222-222222222222',
        source_job_id: '33333333-3333-4333-8333-333333333333',
        verification_job_id: '44444444-4444-4444-8444-444444444444',
        resolved_at: '2026-10-18T12:00:00.000Z'
      };
      Object.assign(row.document, resolution);
      f.restored.records.push({
        fileKey: `payments/${createHash('sha256').update(oldId).digest('hex')}.json`,
        revision: 3,
        document: {
          ...resolution,
          account_key: accountKey,
          target_plan: 'plus',
          checkout_identifier: oldId,
          payment_status: 'unknown',
          payment_attempted: true,
          confirmation_requests_sent: 1,
          payment_requests_sent: 1
        }
      });
    }
    const before = JSON.stringify(f.restored.records);
    const evaluate = mock.evaluate.getMockImplementation()!;
    if (options.refusal)
      mock.evaluate.mockImplementation(async (expression: string) => {
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
    mock.login.mockImplementation(
      async (_settings, _credential, _name, _signal, hooks: DirectLoginHooks) => {
        await hooks.restore!(accountKey);
        await hooks.progress('existing_checkout_read', {
          checkout_identifier: oldId,
          processor_entity: entity,
          quote: { historical_quote: true },
          payment_intent_identifier: 'pi_OldSynthetic',
          initial_quote: { historical_quote: true },
          quote_authority: 'official_checkout_response',
          billing_fingerprint: 'f'.repeat(64),
          first_session_verified_at: '2026-10-18T00:00:00.000Z'
        });
        return hooks.ready!(f.browser);
      }
    );
    mock.apiCallback.mockImplementation(async (_id, _token, body) => {
      if (body.type === 'restore') return f.restored;
      if (body.type === 'replace_expired_checkout') return f.callback(body);
      if (body.type === 'ledger') {
        if (body.document.status === 'checkout_attempted') {
          if (options.ackFailure === 'reject') throw new Error('synthetic marker refused');
          if (options.ackFailure === 'revision') return { revision: body.revision };
        }
        const receipt = await f.callback(body);
        if (body.document.status === 'checkout_attempted' && options.paymentObserved)
          mock.observer.confirmationRequests = 1;
        return receipt;
      }
      // Stop at the displayed, verified final quote; never create a payment authorization.
      if (body.type === 'direct_quote') throw new Error('synthetic hold before payment');
      return { ok: true };
    });
    return {
      ...f,
      before,
      finished: () =>
        mock.apiCallback.mock.calls.find(([, , body]) => body.type === 'finished')?.[2].result,
      async start() {
        await startDirectPayment({
          launch: f.launch,
          plan: 'plus',
          credential: { sessionJson: 'synthetic-fixture' },
          payment: { ...details },
          windowName: '合成新单绑定回归',
          signal: f.browser.signal,
          refresh: vi.fn().mockResolvedValue(undefined),
          reportError: vi.fn()
        });
        await vi.waitFor(() => expect(directPaymentControls.has(f.launch.id)).toBe(false));
      }
    };
  }
  it.each([false, true])(
    '过期/人工同档=%s新标记ACK后400保留真实拒绝但无旧单或报价复活',
    async (resolved) => {
      const f = setup({ resolved, refusal: true });
      await f.start();
      const result = f.finished();
      expect(result).toMatchObject({
        status: 'blocked',
        reason: 'official_checkout_http_failed',
        stage: 'checkout_create',
        http_status: 400,
        checkout_requests_sent: 1,
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0,
        first_session_verified_at: '2026-10-18T00:00:00.000Z'
      });
      for (const field of [
        'checkout_identifier',
        'processor_entity',
        'payment_intent_identifier',
        'quote',
        'initial_quote',
        'quote_authority',
        'billing_fingerprint'
      ])
        expect(result).not.toHaveProperty(field);
      expect(f.events.filter((event) => event === 'create_clicked')).toHaveLength(1);
      expect(JSON.stringify(f.restored.records)).toBe(f.before);
      expect(mock.fill).not.toHaveBeenCalled();
      expect(mock.grant).not.toHaveBeenCalled();
      expect(f.events).not.toContain('payment_clicked');
    }
  );
  it('新单成功出现后只绑定新ID和新最终报价，旧初始报价不恢复', async () => {
    const f = setup();
    await f.start();
    const report = mock.apiCallback.mock.calls.find(
      ([, , body]) => body.type === 'direct_quote'
    )?.[2].result;
    expect(report).toMatchObject({
      checkout_identifier: newId,
      processor_entity: entity,
      quote,
      quote_authority: 'official_checkout_response',
      final_quote_verified: true,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    });
    expect(report).not.toHaveProperty('initial_quote');
    expect(report.quote).not.toHaveProperty('historical_quote');
    expect(f.finished()).toMatchObject({ checkout_identifier: newId, quote });
    expect(JSON.stringify(f.restored.records)).toBe(f.before);
    expect(mock.grant).not.toHaveBeenCalled();
    expect(f.events).not.toContain('payment_clicked');
  });
  it('ACK返回期间观察到付款时保留真实原单与付款计数，不清绑定或继续建单', async () => {
    const f = setup({ paymentObserved: true });
    await f.start();
    expect(f.finished()).toMatchObject({
      status: 'payment_result_unknown',
      checkout_identifier: oldId,
      processor_entity: entity,
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1
    });
    expect(f.events).not.toContain('create_clicked');
    expect(f.events).not.toContain('payment_clicked');
    expect(JSON.stringify(f.restored.records)).toBe(f.before);
    expect(mock.grant).not.toHaveBeenCalled();
  });
  it.each(['reject', 'revision'] as const)(
    '新标记ACK%s时不清旧绑定且不点击或重发',
    async (ackFailure) => {
      const f = setup({ ackFailure });
      await f.start();
      expect(f.finished()).toMatchObject({
        checkout_identifier: oldId,
        processor_entity: entity,
        payment_intent_identifier: 'pi_OldSynthetic',
        quote: { historical_quote: true },
        initial_quote: { historical_quote: true },
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      });
      expect(
        mock.apiCallback.mock.calls.filter(([, , body]) => body.type === 'ledger')
      ).toHaveLength(1);
      expect(f.events).not.toContain('create_clicked');
      expect(f.events).not.toContain('payment_clicked');
      expect(JSON.stringify(f.restored.records)).toBe(f.before);
      expect(mock.grant).not.toHaveBeenCalled();
    }
  );
});

describe('人工确认失败后由正常入口新建单', () => {
  function manualHistory(f: ReturnType<typeof fixture>) {
    const proof = {
      version: 1,
      outcome: 'failure',
      operationId: '22222222-2222-4222-8222-222222222222',
      sourceJobId: '33333333-3333-4333-8333-333333333333',
      operatorId: '44444444-4444-4444-8444-444444444444',
      accountKey,
      identifier: oldId,
      plan: 'plus',
      resolvedAt: '2026-10-19T00:00:00.000Z',
      requestDigest: 'b'.repeat(64)
    };
    const row = f.restored.records[0] as { document: Record<string, unknown> };
    Object.assign(row.document, {
      manual_settlement: { ...proof },
      payment_attempted: true,
      payment_requests_sent: 1,
      confirmation_requests_sent: 1,
      payment_status: 'requires_action'
    });
    f.restored.records.push({
      fileKey: `payments/${createHash('sha256').update(oldId).digest('hex')}.json`,
      revision: 4,
      document: { ...row.document, account_key: accountKey, manual_settlement: { ...proof } }
    });
  }
  it('保留历史实际付款事实，后台确认失败后只建一张新单并停在人工付款确认前', async () => {
    const f = fixture();
    manualHistory(f);
    f.confirm.mockRejectedValue(new Error('SYNTHETIC_STOP_BEFORE_PAYMENT'));
    await expect(f.run()).rejects.toThrow('官网付款操作未完成');
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.events.filter((e) => e === 'create_clicked')).toHaveLength(1);
    expect(f.events).not.toContain('expired_authorized');
    expect(f.events).not.toContain('payment_clicked');
    expect(mock.fill).toHaveBeenCalledOnce();
    expect(f.callback).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ledger',
        document: expect.objectContaining({
          status: 'checkout_attempted',
          retry_of: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      })
    );
    for (const [input] of f.callback.mock.calls)
      expect(JSON.stringify(input)).not.toContain('manual_settlement');
  });
  it.each(['different-source', 'different-account', 'missing-ledger', 'other-pending'])(
    '绑定不一致或其他单未决仍禁止建单：%s',
    async (kind) => {
      const f = fixture();
      manualHistory(f);
      const payment = f.restored.records[1] as { document: Record<string, unknown> };
      if (kind === 'different-source')
        (payment.document.manual_settlement as Record<string, unknown>).sourceJobId =
          '55555555-5555-4555-8555-555555555555';
      if (kind === 'different-account') payment.document.account_key = 'c'.repeat(64);
      if (kind === 'missing-ledger') f.restored.records.splice(1, 1);
      if (kind === 'other-pending')
        f.restored.records.push({
          fileKey: 'payments/' + 'd'.repeat(64) + '.json',
          revision: 1,
          document: {
            account_key: accountKey,
            target_plan: 'plus',
            checkout_identifier: 'oaics_other',
            payment_attempted: true,
            confirmation_requests_sent: 1,
            payment_status: 'requires_action'
          }
        });
      await expect(f.run()).rejects.toThrow();
      expect(f.events).not.toContain('create_clicked');
      expect(mock.fill).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
    }
  );
});
