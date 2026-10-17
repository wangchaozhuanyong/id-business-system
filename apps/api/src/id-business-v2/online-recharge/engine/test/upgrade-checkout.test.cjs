'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rpc = require('../rpc.cjs');
const recovery = require('../checkout-recovery.cjs');
const originalCheckoutUrl = 'https://chatgpt.com/checkout/openai_llc/oaics_fixtureUpgradeCheckout';
const {
  parseUpgradeQuote,
  matchSavedCard,
  completeUpgradePayment,
  buildPaymentContext
} = require('../upstream/upgrade-checkout');

const body = (tier = '500', due = '28,095.37') => `确认套餐变更
你即将升级到 ChatGPT Pro ${tier}。
ChatGPT Pro ${tier}
PHP 29,008.93
从今天起按月计费
抵扣金额
-PHP 913.56
今天应付总额
PHP ${due}
付款方式
Visa •••• 4242 12/29
立即支付`;
const card = { id: 'synthetic-card', number: '4242424242424242', expiry: '12/29', cvc: '123' };
const preflight = {
  allowed: true,
  kind: 'upgrade',
  sourcePlan: 'plus',
  targetPlan: 'pro_500',
  confirmation: { accountId: 'synthetic-account', expectedAccountId: 'synthetic-account' }
};
const options = { planType: 'pro_500', operation: 'upgrade', expectedCurrency: 'PHP', preflight };

function mockPage({
  text = body(),
  methods = [{ index: 0, last4: '4242', brand: 'visa', expiry: '12/29' }],
  clickError = null,
  url = originalCheckoutUrl
} = {}) {
  let selected = false;
  const calls = { choose: 0, submit: 0 };
  const radio = {
    click: async () => {
      selected = true;
      calls.choose++;
    },
    getAttribute: async () => (selected ? 'true' : 'false'),
    isChecked: async () => selected
  };
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    isDisabled: async () => false,
    click: async () => {
      calls.submit++;
      if (clickError) throw clickError;
    }
  };
  const dialog = {
    filter() {
      return this;
    },
    count: async () => 1,
    isVisible: async () => true,
    innerText: async () => text,
    evaluate: async () => methods,
    locator: (selector) =>
      selector.startsWith('input') ? { count: async () => 0 } : { nth: () => radio },
    getByRole: () => button
  };
  return { page: { getByRole: () => dialog, url: () => url, on: () => {}, off: () => {} }, calls };
}
test.beforeEach(() => {
  rpc.configureTask({ id: 'synthetic-upgrade', leaseId: 'synthetic-lease' });
  rpc.setTransportForTest(async () => ({ ok: true }));
});
test.afterEach(() => {
  rpc.clearTask();
  rpc.setTransportForTest(null);
});

test('upgrade uses official due total after credit, retaining exact decimal strings', () => {
  assert.deepEqual(parseUpgradeQuote(body(), 'pro_500', 'PHP'), {
    targetPlan: 'pro_500',
    amount: '28095.37',
    currency: 'PHP',
    recurringAmount: '29008.93',
    creditAmount: '913.56',
    taxAmount: null,
    source: 'subscription_change',
    zeroDue: false
  });
});
test('all three exact tier labels work; generic Pro and mismatched tiers are blocked', () => {
  for (const [plan, tier] of [
    ['pro_5x', '100'],
    ['pro_20x', '200'],
    ['pro_500', '500']
  ])
    assert.equal(parseUpgradeQuote(body(tier), plan, 'PHP').targetPlan, plan);
  assert.throws(() => parseUpgradeQuote(body('200'), 'pro_500', 'PHP'), /目标档位/);
  assert.throws(
    () => parseUpgradeQuote(body().replaceAll('Pro 500', 'Pro'), 'pro_500', 'PHP'),
    /目标档位/
  );
});
test('monthly price cannot replace missing due, different currency or ambiguous total', () => {
  assert.throws(
    () => parseUpgradeQuote(body().replace('今天应付总额', '月费'), 'pro_500', 'PHP'),
    /应付/
  );
  assert.throws(() => parseUpgradeQuote(body(), 'pro_500', 'USD'), /币种/);
  assert.throws(
    () => parseUpgradeQuote(`${body()}\n今天应付总额 PHP 2.00`, 'pro_500', 'PHP'),
    /应付/
  );
});
test('official zero due is explicit; malformed credits and taxes are not guessed', () => {
  const zero = parseUpgradeQuote(body('500', '0.00'), 'pro_500', 'PHP');
  assert.equal(zero.amount, '0.00');
  assert.equal(zero.zeroDue, true);
  assert.throws(
    () => parseUpgradeQuote(body().replace('-PHP 913.56', '等待报价'), 'pro_500', 'PHP'),
    /折抵/
  );
  assert.throws(() => parseUpgradeQuote(`${body()}\n税费\n待核对`, 'pro_500', 'PHP'), /税费/);
});
test('saved card needs unique last4 plus matching brand and visible expiry', () => {
  const match = { index: 1, last4: '4242', brand: 'visa', expiry: '12/2029' };
  assert.equal(matchSavedCard([match], card), match);
  assert.throws(() => matchSavedCard([match, { ...match, index: 2 }], card), /不唯一/);
  assert.throws(() => matchSavedCard([{ ...match, expiry: null }], card), /有效期/);
  assert.throws(() => matchSavedCard([{ ...match, brand: 'mastercard' }], card), /品牌/);
  assert.throws(() => matchSavedCard([{ ...match, last4: '9173' }], card), /尾号/);
});
test('durable gate contains original account, original tier, exact target, card lease and actual due before one click', async () => {
  const { page, calls } = mockPage();
  let intent;
  let recoveryIdentity;
  rpc.setTransportForTest(async (method, input) => {
    assert.equal(method, 'beforeExternalSubmit');
    assert.equal(calls.submit, 0);
    intent = input.paymentContext;
    recoveryIdentity = input.checkoutRecovery;
    return { ok: true };
  });
  const result = await completeUpgradePayment(page, card, options);
  assert.equal(result.resultUnknown, true);
  assert.equal(result.success, false);
  assert.equal(result.submitted, true);
  assert.equal(calls.submit, 1);
  assert.deepEqual(intent, {
    kind: 'upgrade',
    sourcePlan: 'plus',
    targetPlan: 'pro_500',
    accountId: 'synthetic-account',
    cardId: 'synthetic-card',
    cardLast4: '4242',
    amount: '28095.37',
    currency: 'PHP',
    quoteId: recovery.quoteIdForUrl(originalCheckoutUrl)
  });
  assert.equal(recoveryIdentity.checkoutUrl, originalCheckoutUrl);
  assert.equal(recoveryIdentity.quoteId, intent.quoteId);
  assert.equal(JSON.stringify(intent).includes(card.number), false);
  assert.equal(result.paymentEvidence.verified, false);
  assert.equal(result.paymentEvidence.quoteVerified, true);
  await assert.rejects(
    () => completeUpgradePayment(page, card, options),
    (error) => error.code === 'RESULT_UNKNOWN'
  );
  assert.equal(calls.submit, 1);
});

for (const due of ['28,095.37', '0.00'])
  test(`an upgrade quote ${due} without an actual original checkout identity stops before any submission`, async () => {
    const { page, calls } = mockPage({
      text: body('500', due),
      url: 'https://chatgpt.com/#pricing'
    });
    let submissions = 0;
    rpc.setTransportForTest(async () => {
      submissions++;
      return { ok: true };
    });
    const result = await completeUpgradePayment(page, card, options);
    assert.equal(result.submitted, false);
    assert.equal(result.errorCode, 'CHECKOUT_RECOVERY_UNAVAILABLE');
    assert.equal(result.upgradeQuote.zeroDue, due === '0.00');
    assert.equal(calls.submit, 0);
    assert.equal(calls.choose, 0);
    assert.equal(submissions, 0);
    assert.equal(rpc.wasSubmitted(), false);
  });
test('default selected unrelated or unverifiable saved card is never paid', async () => {
  const { page, calls } = mockPage({
    methods: [{ index: 0, last4: '4242', brand: 'visa', expiry: null }]
  });
  const result = await completeUpgradePayment(page, card, options);
  assert.equal(result.submitted, false);
  assert.equal(result.canRetryCard, false);
  assert.equal(calls.submit, 0);
  assert.equal(calls.choose, 0);
  assert.equal(rpc.wasSubmitted(), false);
});
test('lease lost before submit never clicks; lost click response cannot replay', async () => {
  const first = mockPage();
  rpc.setTransportForTest(async () => {
    const error = new Error('synthetic');
    error.code = 'LEASE_LOST';
    throw error;
  });
  await assert.rejects(
    () => completeUpgradePayment(first.page, card, options),
    (error) => error.code === 'LEASE_LOST'
  );
  assert.equal(first.calls.submit, 0);
  assert.equal(rpc.wasSubmitted(), false);
  rpc.setTransportForTest(async () => ({ ok: true }));
  const second = mockPage({ clickError: new Error('synthetic response lost') });
  await assert.rejects(
    () => completeUpgradePayment(second.page, card, options),
    (error) => error.code === 'RESULT_UNKNOWN'
  );
  assert.equal(second.calls.submit, 1);
  assert.equal(rpc.wasSubmitted(), true);
});
test('missing preflight or wrong account cannot produce payment context', () => {
  const quote = parseUpgradeQuote(body(), 'pro_500', 'PHP');
  assert.throws(
    () => buildPaymentContext({ ...options, preflight: null }, card, quote),
    /核验资料/
  );
  assert.throws(
    () =>
      buildPaymentContext(
        {
          ...options,
          preflight: { ...preflight, confirmation: { expectedAccountId: 'one', accountId: 'two' } }
        },
        card,
        quote
      ),
    /核验资料/
  );
});

test('successful-looking authentication or unrelated return pages cannot prove original checkout payment', () => {
  const { isVerifiedCheckoutOutcome } = require('../upstream/stripe-payment');
  const original = 'https://chatgpt.com/checkout/openai_llc/oaics_synthetic';
  assert.equal(
    isVerifiedCheckoutOutcome(original, 'https://chatgpt.com/?redirect_status=succeeded'),
    true
  );
  assert.equal(
    isVerifiedCheckoutOutcome(original, 'https://chatgpt.com/auth/login?redirect_status=succeeded'),
    false
  );
  assert.equal(
    isVerifiedCheckoutOutcome(original, 'https://unrelated.test/?redirect_status=succeeded'),
    false
  );
  assert.equal(
    isVerifiedCheckoutOutcome(original, 'https://checkout.stripe.com/?redirect_status=succeeded'),
    false
  );
  assert.equal(
    isVerifiedCheckoutOutcome(
      'https://checkout.stripe.com/session?return_url=' +
        encodeURIComponent('https://chatgpt.com/checkout/return'),
      'https://chatgpt.com/checkout/return?redirect_status=succeeded'
    ),
    true
  );
  assert.equal(
    isVerifiedCheckoutOutcome(
      'https://checkout.stripe.com/session?return_url=' +
        encodeURIComponent('https://chatgpt.com/checkout/return'),
      'https://chatgpt.com/other?redirect_status=succeeded'
    ),
    false
  );
});

test('upgrade does not cancel or restore renewal after success; initial activation keeps its existing policy', async () => {
  const { applyPostPaymentRenewalPolicy } = require('../upstream/upgrade-checkout');
  let calls = 0;
  const cancel = async (_token, options) => {
    calls++;
    assert.equal(options.email, 'synthetic@example.test');
    return { ok: true };
  };
  assert.equal(
    await applyPostPaymentRenewalPolicy(
      'upgrade',
      'synthetic-token',
      'synthetic@example.test',
      cancel
    ),
    null
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await applyPostPaymentRenewalPolicy(
      'initial',
      'synthetic-token',
      'synthetic@example.test',
      cancel
    ),
    { ok: true }
  );
  assert.equal(calls, 1);
  await assert.rejects(() =>
    applyPostPaymentRenewalPolicy('unknown', 'synthetic-token', 'synthetic@example.test', cancel)
  );
  assert.equal(calls, 1);
});

test('initial post-payment renewal helper forwards the same task browser and cancellation options', async () => {
  const { applyPostPaymentRenewalPolicy } = require('../upstream/upgrade-checkout');
  const page = {},
    browserContext = {},
    signal = new AbortController().signal;
  const options = { page, browserContext, signal, deadlineAt: 12345 };
  let received;
  const result = await applyPostPaymentRenewalPolicy(
    'initial',
    'synthetic-token',
    'synthetic@example.test',
    async (_token, value) => {
      received = value;
      return { ok: false };
    },
    options
  );
  assert.equal(result.ok, false);
  assert.equal(received.page, page);
  assert.equal(received.browserContext, browserContext);
  assert.equal(received.signal, signal);
  assert.equal(received.deadlineAt, options.deadlineAt);
  assert.equal(received.email, 'synthetic@example.test');
});
