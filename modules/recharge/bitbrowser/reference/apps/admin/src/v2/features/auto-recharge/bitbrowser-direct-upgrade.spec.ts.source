import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2RechargeBitBrowserLaunch, V2RechargeDetails } from './contracts';
import type { DirectPaymentHooks } from './bitbrowser-direct-payment';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import {
  matchingDirectUpgradeMethods,
  runDirectSubscriptionUpgrade,
  verifyDirectUpgradePreview
} from './bitbrowser-direct-upgrade';

const fake = vi.hoisted(() => ({
  evaluate: vi.fn(),
  observer: undefined as unknown,
  close: vi.fn()
}));
vi.mock('./bitbrowser-payment-session', async (importOriginal) => {
  const original = await importOriginal<typeof import('./bitbrowser-payment-session')>();
  return {
    ...original,
    createDirectPaymentSession: vi.fn(async (browser: VerifiedPaymentBrowser) => ({
      session: { signal: browser.signal, evaluate: fake.evaluate, frames: async () => [] },
      ownsSession: () => true,
      close: fake.close
    }))
  };
});
vi.mock('./bitbrowser-payment-observer', () => ({
  DirectPaymentObserver: class {
    confirmationRequests = 0;
    failure = '';
    paymentStatus = 'unknown';
    linkedIntent = '';
    invoiceId = '';
    evidence?: object;
    onBinding?: (binding: object) => Promise<void>;
    constructor() {
      fake.observer = this;
    }
    bindUpgrade = vi.fn();
    arm = vi.fn();
    close = vi.fn();
    settle = vi.fn(async () => undefined);
  }
}));
vi.mock('./bitbrowser-payment-page', () => ({
  directPaymentPageExpression: (_plan: string, action: string) => `page:${action}`
}));

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
const preview = () => ({
  currency: 'usd',
  positive_line_item_total: 10000,
  negative_line_item_total: -2000,
  amount_due: { amount: 8800, amount_excluding_tax: 8000, tax_amount: 800 }
});
const text = 'ChatGPT Pro\nUSD 100.00\nBilled monthly\nTotal due today USD 88.00\nTax USD 8.00';
const method = () => ({
  id: 'pm_synthetic',
  type: 'card',
  billing_details: {
    name: details.name,
    address: {
      country: details.country,
      line1: details.line1,
      line2: details.line2,
      city: details.city,
      state: details.state,
      postal_code: details.postal_code
    }
  },
  card: { last4: '4242', exp_month: 12, exp_year: 2039 }
});

describe('直连升级报价和卡片归属', () => {
  it('按整数分核对当日费用、折抵、税费和月度续费', () => {
    const quote = verifyDirectUpgradePreview(preview(), 'pro-20x', text, 'USD');
    expect(quote.today?.amount_minor).toBe(8800);
    expect(quote.tax?.amount_minor).toBe(800);
    expect(quote.renewal?.amount_minor).toBe(10000);
    expect(quote.credit?.amount_minor).toBe(2000);
  });
  it('官网明确零税额时允许未列税费行', () => {
    const input = preview();
    input.amount_due = { amount: 8000, amount_excluding_tax: 8000, tax_amount: 0 };
    const quote = verifyDirectUpgradePreview(
      input,
      'pro-20x',
      text.replace('88.00', '80.00').replace('\nTax USD 8.00', ''),
      'USD'
    );
    expect(quote.tax?.amount_minor).toBe(0);
  });
  it.each([
    { currency: 'php' },
    { positive_line_item_total: 10000.1 },
    { negative_line_item_total: 1 },
    { applied_balance: 100 },
    { discount_amount: 100 },
    { amount_due: { amount: 8801, amount_excluding_tax: 8000, tax_amount: 800 } },
    { amount_due: { amount: 8800, amount_excluding_tax: 8100, tax_amount: 800 } },
    { amount_due: { amount: 8800, amount_excluding_tax: 8000, tax_amount: -800 } }
  ])('拒绝未核实金额 %j', (change) =>
    expect(() =>
      verifyDirectUpgradePreview({ ...preview(), ...change }, 'pro-20x', text, 'USD')
    ).toThrow()
  );
  it.each([
    text.replace('88.00', '87.00'),
    text.replace('Tax USD 8.00', 'Tax USD 9.00'),
    text.replace('100.00', '99.00'),
    text.replace('Billed monthly', 'Billed annually'),
    `${text}\nUSD 90\nBilled monthly`,
    `${text}\nThen USD 50 / month`
  ])('拒绝页面金额或月度周期歧义', (value) =>
    expect(() => verifyDirectUpgradePreview(preview(), 'pro-20x', value, 'USD')).toThrow()
  );
  it('只选择本账户尾号和有效期唯一匹配卡片', () => {
    expect(
      matchingDirectUpgradeMethods(
        { account_id: 'account', payment_methods: [method()] },
        details,
        'account'
      ).selected
    ).toBe('pm_synthetic');
  });
  it.each([
    { account_id: 'other', payment_methods: [method()] },
    {},
    { payment_methods: [method(), method()] },
    { payment_methods: [{ ...method(), id: 'invalid' }] },
    { payment_methods: [method(), { ...method(), id: 'pm_second' }] }
  ])('拒绝付款方式归属或编号歧义 %j', (data) =>
    expect(() => matchingDirectUpgradeMethods(data, details, 'account')).toThrow()
  );
  it.each([
    { ...method(), billing_details: undefined },
    { ...method(), billing_details: { ...method().billing_details, name: 'Another Buyer' } },
    {
      ...method(),
      billing_details: {
        ...method().billing_details,
        address: { ...method().billing_details.address, line1: 'Other Street' }
      }
    },
    {
      ...method(),
      billing_details: {
        ...method().billing_details,
        address: { ...method().billing_details.address, country: 'PH' }
      }
    },
    { ...method(), type: 'bank' },
    { ...method(), is_healthy: false },
    { ...method(), is_deleted: true },
    { ...method(), card: { last4: '9999', exp_month: 12, exp_year: 2039 } },
    { ...method(), card: { last4: '4242', exp_month: 1, exp_year: 2039 } }
  ])('不选择不匹配或失效的卡片', (value) =>
    expect(
      matchingDirectUpgradeMethods({ payment_methods: [value] }, details, 'account').selected
    ).toBeUndefined()
  );
});

describe('直连升级的单次人工付款授权', () => {
  let clicked: boolean;
  let changedQuote: boolean;
  let resultPlan: string;
  let browser: VerifiedPaymentBrowser;
  let hooks: DirectPaymentHooks;
  const launch = { safety: { lockedCurrency: 'USD' } } as V2RechargeBitBrowserLaunch;
  beforeEach(() => {
    vi.clearAllMocks();
    clicked = false;
    changedQuote = false;
    resultPlan = 'pro';
    browser = {
      identity: {
        accountId: 'account',
        userId: 'user',
        email: 'buyer@example.invalid',
        plan: 'plus'
      },
      profileId: 'owned-profile',
      sessionId: 'owned-session',
      signal: new AbortController().signal,
      cdp: { command: vi.fn(async () => ({})) }
    } as unknown as VerifiedPaymentBrowser;
    hooks = {
      callback: vi.fn(),
      unexpected: vi.fn(async () => undefined),
      progress: vi.fn(async () => undefined),
      attempted: () => false,
      confirm: vi.fn(async (_report, preflight) => {
        await preflight();
      })
    };
    fake.evaluate.mockImplementation(async (expression: string) => {
      if (expression === 'page:prepare') return { kind: 'plan_ready' };
      if (expression === 'page:create') return { kind: 'submitted' };
      if (expression.includes('/backend-api/subscriptions?account_id='))
        return {
          ok: true,
          data: {
            account_id: 'account',
            plan_type: clicked ? resultPlan : 'plus',
            is_processor_stripe: true,
            will_renew: true
          }
        };
      if (expression.includes('/backend-api/payments/payment_methods?'))
        return { ok: true, data: { account_id: 'account', payment_methods: [method()] } };
      if (expression.includes('/backend-api/subscriptions/update/preview?'))
        return { ok: true, data: preview() };
      const action = /\}\)\("([a-z]+)"/.exec(expression)?.[1];
      if (action === 'inspect') return { kind: 'ready', text };
      if (action === 'select' || action === 'selected')
        return { kind: 'selected', text: changedQuote ? text.replace('88.00', '89.00') : text };
      if (action === 'confirm') {
        clicked = true;
        const observer = fake.observer as {
          arm: ReturnType<typeof vi.fn>;
          onBinding: (value: object) => Promise<void>;
          evidence: object;
          linkedIntent: string;
          confirmationRequests: number;
          paymentStatus: string;
        };
        expect(observer.arm).toHaveBeenCalledOnce();
        observer.linkedIntent = 'pi_synthetic';
        observer.confirmationRequests = 1;
        await observer.onBinding({
          payment_intent_identifier: 'pi_synthetic',
          upgrade_payment_intent_identifier: 'pi_synthetic'
        });
        observer.evidence = {
          kind: 'payment_intent',
          identifier: 'pi_synthetic',
          amount_minor: 8800,
          currency: 'USD'
        };
        observer.paymentStatus = 'paid';
        return { kind: 'submitted' };
      }
      throw new Error('Unexpected synthetic browser expression');
    });
  });
  it('服务器消费人工确认后才点击，并先绑定PI再回传付款成功', async () => {
    const result = await runDirectSubscriptionUpgrade(browser, launch, 'pro-20x', details, hooks);
    expect(hooks.confirm).toHaveBeenCalledOnce();
    expect(result.status).toBe('subscription_activated');
    expect(result.payment_intent_identifier).toBe('pi_synthetic');
    expect(hooks.progress).toHaveBeenCalledWith(
      'payment_submitted_or_pending',
      expect.objectContaining({ payment_intent_identifier: 'pi_synthetic' })
    );
    expect(fake.close).toHaveBeenCalledOnce();
  });
  it('人工确认被拒绝时不点击付款', async () => {
    hooks.confirm = vi.fn(async () => {
      throw new Error('confirmation refused');
    });
    await expect(
      runDirectSubscriptionUpgrade(browser, launch, 'pro-20x', details, hooks)
    ).rejects.toThrow('confirmation refused');
    expect(clicked).toBe(false);
    expect(fake.close).toHaveBeenCalledOnce();
  });
  it('最高额度套餐保留官网promax类型，不按金额推算倍数', async () => {
    resultPlan = 'promax';
    const result = await runDirectSubscriptionUpgrade(browser, launch, 'pro-500', details, hooks);
    expect(result.status).toBe('subscription_activated');
    expect(result.current_plan).toBe('promax');
    expect(result.current_tier).toBeUndefined();
  });
  it('确认时官网金额变化会使本次授权失效', async () => {
    hooks.confirm = vi.fn(async (_report, preflight) => {
      changedQuote = true;
      await preflight();
    });
    await expect(
      runDirectSubscriptionUpgrade(browser, launch, 'pro-20x', details, hooks)
    ).rejects.toThrow();
    expect(clicked).toBe(false);
  });
  it('已是目标订阅或不支持的升级来源时不进入购买流程', async () => {
    browser.identity.plan = 'pro';
    await expect(
      runDirectSubscriptionUpgrade(browser, launch, 'pro-20x', details, hooks)
    ).rejects.toThrow();
    expect(fake.evaluate).not.toHaveBeenCalled();
    expect(hooks.confirm).not.toHaveBeenCalled();
  });
  it('服务器授权往返期间金额变化时，授权返回后再次校验并阻止点击', async () => {
    hooks.confirm = vi.fn(async (_report, preflight) => {
      await preflight();
      changedQuote = true;
    });
    await expect(
      runDirectSubscriptionUpgrade(browser, launch, 'pro-20x', details, hooks)
    ).rejects.toThrow();
    expect(clicked).toBe(false);
  });
  it('官网提前发生升级付款时回传原升级绑定并等待负向锁，不继续点击', async () => {
    hooks.confirm = vi.fn(async (_report, preflight) => {
      const observer = fake.observer as {
        confirmationRequests: number;
        failure: string;
        onUnexpected: (facts: object) => Promise<void>;
      };
      observer.confirmationRequests = 1;
      observer.failure = 'unexpected_payment_observed';
      await observer.onUnexpected({ payment_requests_sent: 1, confirmation_requests_sent: 1 });
      await preflight();
    });
    await expect(
      runDirectSubscriptionUpgrade(browser, launch, 'pro-20x', details, hooks)
    ).rejects.toThrow();
    expect(hooks.unexpected).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'subscription_upgrade',
        upgrade_identifier: expect.stringMatching(/^upg_[a-f0-9]{32}$/),
        target_plan: 'pro-20x',
        confirmation_requests_sent: 1
      })
    );
    expect(clicked).toBe(false);
    expect((fake.observer as { settle: unknown }).settle).toHaveBeenCalledOnce();
  });
});
