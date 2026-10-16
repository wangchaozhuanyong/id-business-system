'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.PAYMENT_RESULT_TIMEOUT_MS = '20';
process.env.CAPTCHA_OVERLAY_WAIT_MS = '20';
const stripe = require('../upstream/stripe-payment');
const { isPaymentDeclined } = require('../upstream/payment-retry');
function pageFor(body) {
  const locator = {
    first() {
      return this;
    },
    nth() {
      return this;
    },
    filter() {
      return this;
    },
    count: async () => 0,
    isVisible: async () => false,
    textContent: async () => ''
  };
  return {
    url: () => 'https://chatgpt.com/checkout/openai_llc/synthetic',
    setDefaultTimeout() {},
    locator: () => locator,
    getByRole: () => locator,
    getByText: () => locator,
    frames: () => [],
    evaluate: async () => false,
    textContent: async () => body,
    waitForTimeout: async () => new Promise((resolve) => setTimeout(resolve, 25))
  };
}
for (const body of [
  'Your plan change could not be completed. Please try again.',
  '未能完成此次套餐变更。请重试。',
  'Payment failed',
  'Payment was not successful'
])
  test(`generic checkout error remains unknown: ${body}`, async () => {
    const page = pageFor(body);
    assert.equal((await stripe.handlePostSubmitPhase(page)).action, 'unknown');
    const result = await stripe.waitForPaymentResult(page, 'Synthetic');
    assert.equal(result.resultUnknown, true);
    assert.notEqual(result.declined, true);
    assert.equal(isPaymentDeclined(body), false);
  });

test('specific issuer rejection stays a card rejection even with a generic failure title', async () => {
  const result = await stripe.waitForPaymentResult(
    pageFor('Payment failed. Your card was declined.'),
    'Synthetic'
  );
  assert.equal(result.declined, true);
  assert.equal(result.canRetryCard, true);
});

test('lingering earlier rejection stops before another submit button is sought', async () => {
  const page = pageFor('Your card was declined.');
  page.getByRole = () => {
    throw new Error('must not locate a payment button');
  };
  const result = await stripe.finalizeCheckoutPayment(page, 'Synthetic');
  assert.equal(result.success, false);
  assert.equal(result.canRetryCard, false);
  assert.notEqual(result.declined, true);
});

const amounts = [
  [
    'Monthly subscription\n$200.00\nCredit\n-$10.00\nDue today\n$190.00',
    { amount: '190.00', currency: 'USD' }
  ],
  [
    '月费 PHP 5,794.64\n抵扣 -PHP 309.91\n今日应付总额\nPHP 5,484.73',
    { amount: '5484.73', currency: 'PHP' }
  ],
  ['Due today: US$ 1,100.25', { amount: '1100.25', currency: 'USD' }],
  ['Amount due\n190.00 USD', { amount: '190.00', currency: 'USD' }],
  ['Total due\nS$ 27', { amount: '27.00', currency: 'SGD' }],
  ['Subtotal\n$200.00\nDiscount\n-$10.00', null],
  ['Monthly subscription $200.00\nDue today\ncalculating tax', null],
  ['Due today $190.00\nDue today $200.00', null],
  ['Due today €1.234,56', null]
];
for (const [text, expected] of amounts)
  test(`payable total is precise or unknown: ${JSON.stringify(text)}`, async () => {
    assert.deepEqual(await stripe.readCheckoutDueAmount(pageFor(text)), expected);
  });

const { preflightPayment } = require('../confirmation.cjs');
const { parseAccountCheckResponse } = require('../upstream/subscription-check');
const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'original-account' } })).toString('base64url')}.x`;
for (const [name, queryResult, allowed, alreadyActive] of [
  [
    'same account free plan',
    {
      ok: true,
      data: { upstreamAccountId: 'original-account', rawPlan: 'free', hasActiveSubscription: false }
    },
    true,
    false
  ],
  [
    'actual free account response without an entitlement plan',
    {
      ok: true,
      data: parseAccountCheckResponse({
        accounts: {
          default: {
            account: { account_id: 'original-account' },
            entitlement: { has_active_subscription: false }
          }
        }
      })
    },
    true,
    false
  ],
  [
    'exact existing target plan',
    {
      ok: true,
      data: {
        upstreamAccountId: 'original-account',
        rawPlan: 'chatgptprolite',
        hasActiveSubscription: true
      }
    },
    false,
    true
  ],
  [
    'wrong account',
    {
      ok: true,
      data: { upstreamAccountId: 'other-account', rawPlan: 'free', hasActiveSubscription: false }
    },
    false,
    false
  ],
  ['unavailable subscription query', { ok: false }, false, false],
  [
    'unknown active state with a free plan label',
    {
      ok: true,
      data: { upstreamAccountId: 'original-account', rawPlan: 'free' }
    },
    false,
    false
  ],
  [
    'actual account response with missing entitlement status',
    {
      ok: true,
      data: parseAccountCheckResponse({
        accounts: { default: { account: { account_id: 'original-account' } } }
      })
    },
    false,
    false
  ],
  [
    'active subscription without a plan',
    {
      ok: true,
      data: { upstreamAccountId: 'original-account', hasActiveSubscription: true }
    },
    false,
    false
  ],
  [
    'another free account without a plan',
    {
      ok: true,
      data: { upstreamAccountId: 'other-account', hasActiveSubscription: false }
    },
    false,
    false
  ],
  [
    'missing subscription plan',
    { ok: true, data: { upstreamAccountId: 'original-account' } },
    false,
    false
  ]
])
  test(`payment preflight: ${name}`, async () => {
    let reads = 0;
    const result = await preflightPayment('pro_5x', token, {
      query: async () => {
        reads++;
        return queryResult;
      }
    });
    assert.equal(result.allowed, allowed);
    assert.equal(result.alreadyActive, alreadyActive);
    assert.equal(reads, 1);
  });
