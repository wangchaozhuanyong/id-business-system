'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getRegionBilling, getRegionBrowserProfile } = require('../upstream/region-config');
const { parseLabelledChileMoney } = require('../upstream/chile-money');
const {
  parseCheckoutDueAmount,
  ensureCheckoutTaxFreeAmount,
  waitForCheckoutTaxRecalculation,
  billingCountryOptions
} = require('../upstream/stripe-payment');
const { parseUpgradeQuote } = require('../upstream/upgrade-checkout');
const {
  evaluateSubscription,
  resolvePaymentCurrency,
  preflightPayment
} = require('../confirmation.cjs');
const { pageShowsTargetRegionPricing } = require('../upstream/pricing-checkout');

test('CL region uses Chilean currency and timezone', () => {
  assert.equal(getRegionBilling('CL').currency, 'CLP');
  assert.equal(getRegionBrowserProfile('CL').timezoneId, 'America/Santiago');
  assert.throws(
    () => require('../upstream/chatgpt').prototype.getPlanAmount('pro_5x', 'CLP'),
    /官网实际报价/
  );
});

test('Chilean pricing needs explicit CLP evidence and rejects conflicting or ambiguous currency', async () => {
  const page = (text) => ({
    locator: () => ({
      first() {
        return this;
      },
      isVisible: async () => true,
      innerText: async () => text
    })
  });
  assert.equal(await pageShowsTargetRegionPricing(page('Chile\nPro 100\nCLP 100.000'), 'CL'), true);
  assert.equal(await pageShowsTargetRegionPricing(page('Chile\nPro 100\n$100.000'), 'CL'), false);
  assert.equal(
    await pageShowsTargetRegionPricing(page('Chile\nCLP 100.000\nPHP 1,000'), 'CL'),
    false
  );
  assert.equal(await pageShowsTargetRegionPricing(page('Philippines\n₱1,000'), 'CL'), false);
});

test('CLP integer and thousands formats stay exact without guessing bare dollar signs', () => {
  for (const amount of ['CLP$ 123.456', 'CLP $ 123,456'])
    assert.deepEqual(parseCheckoutDueAmount(`Due today ${amount}`), {
      amount: '123456',
      currency: 'CLP'
    });
  for (const amount of ['123456', '123.456', '123,456', '123.456,00', '123,456.00']) {
    assert.deepEqual(parseCheckoutDueAmount(`Total due today CLP ${amount}`), {
      amount: '123456',
      currency: 'CLP'
    });
  }
  assert.deepEqual(parseCheckoutDueAmount('今天应付总额 CL$ 123.456'), {
    amount: '123456',
    currency: 'CLP'
  });
  assert.deepEqual(parseCheckoutDueAmount('Total due today 123.456 CLP'), {
    amount: '123456',
    currency: 'CLP'
  });
  assert.equal(parseCheckoutDueAmount('Total due today CLP 0'), null);
  assert.deepEqual(parseCheckoutDueAmount('Total due today CLP 0', { allowZero: true }), {
    amount: '0',
    currency: 'CLP'
  });
  assert.notEqual(parseCheckoutDueAmount('Total due today $123,456')?.currency, 'CLP');
  for (const invalid of ['12.34', '1,234.567', '1234.50', '1.234,56'])
    assert.equal(parseLabelledChileMoney(`Due today CLP ${invalid}`, 'Due today'), null);
  assert.equal(parseLabelledChileMoney('Due today CLP 100\nDue today CLP 200', 'Due today'), null);
  assert.equal(
    parseLabelledChileMoney('Due today CLP 100\nDue today CLP 12.34', 'Due today'),
    null
  );
});

test('CLP upgrade quotes preserve official due, credit and tax as whole pesos', () => {
  const text =
    'Confirm plan change\nChatGPT Pro 100\nCLP 100.000\nCredit amount -CLP 1.000\nTax CLP 19.000\nDue today CLP 118.000';
  assert.deepEqual(parseUpgradeQuote(text, 'pro_5x', 'CLP'), {
    targetPlan: 'pro_5x',
    amount: '118000',
    currency: 'CLP',
    recurringAmount: '100000',
    creditAmount: '1000',
    taxAmount: '19000',
    source: 'subscription_change',
    zeroDue: false
  });
  assert.throws(() => parseUpgradeQuote(text, 'pro_5x', 'PHP'), /币种/);
  assert.throws(() => parseUpgradeQuote(text, 'pro_500', 'CLP'), /目标档位/);
});

test('active Plus retains its currency and pauses if it conflicts with the plan route', () => {
  const previous = process.env.PLAN_REGION_EXPECTED_CURRENCY;
  process.env.PLAN_REGION_EXPECTED_CURRENCY = 'CLP';
  try {
    const upgrade = (currency) => ({
      allowed: true,
      kind: 'upgrade',
      confirmation: evaluateSubscription('pro_5x', 'account-one', {
        ok: true,
        data: {
          rawPlan: 'plus',
          upstreamAccountId: 'account-one',
          hasActiveSubscription: true,
          currency
        }
      })
    });
    assert.throws(() => resolvePaymentCurrency(upgrade('PHP'), 'CLP'), /币种/);
    assert.equal(resolvePaymentCurrency(upgrade('CLP'), 'CLP'), 'CLP');
    assert.throws(
      () => resolvePaymentCurrency(upgrade(''), 'CLP', { debugOnly: true }),
      /原订阅币种/
    );
    assert.equal(resolvePaymentCurrency({ allowed: true, kind: 'initial' }, 'CLP'), 'CLP');
  } finally {
    if (previous === undefined) delete process.env.PLAN_REGION_EXPECTED_CURRENCY;
    else process.env.PLAN_REGION_EXPECTED_CURRENCY = previous;
  }
});

test('only confirmed inactive and expired paid accounts can reopen; cancelled active accounts still upgrade', async () => {
  const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-one' } })).toString('base64url')}.x`;
  const check = (active, expiresAt, rawPlan = 'plus') =>
    preflightPayment('pro_5x', token, {
      query: async () => ({
        ok: true,
        data: {
          upstreamAccountId: 'account-one',
          rawPlan,
          hasActiveSubscription: active,
          expiresAt,
          autoRenewRaw: false,
          currency: 'PHP'
        }
      })
    });
  assert.equal((await check(false, '2000-01-01T00:00:00.000Z')).kind, 'initial');
  assert.equal((await check(true, '2999-01-01T00:00:00.000Z')).kind, 'upgrade');
  for (const expiry of [undefined, 'invalid', '2000', '2999-01-01T00:00:00.000Z'])
    assert.equal((await check(false, expiry)).allowed, false);
  assert.equal((await check(false, '2000-01-01T00:00:00.000Z', 'pro')).allowed, false);
  assert.equal((await check(false, undefined, 'free')).kind, 'initial');
});

test('Chile waits for stable official tax total and does not subtract Philippine tax', async () => {
  const previous = process.env.PAYMENT_REGION_OVERRIDE;
  process.env.PAYMENT_REGION_OVERRIDE = 'CL';
  try {
    let calls = 0;
    const page = {
      textContent: async () => `Total due today CLP ${++calls === 1 ? '110.000' : '119.000'}`,
      waitForTimeout: async () => {}
    };
    const result = await ensureCheckoutTaxFreeAmount(
      page,
      {},
      { amount: '100000', currency: 'CLP' }
    );
    assert.equal(result.ok, true);
    assert.equal(result.due.amount, '119000');
    assert.ok(calls >= 4);
    assert.equal(
      (await waitForCheckoutTaxRecalculation(page, { baselineAmount: '100000' })).due.amount,
      '119000'
    );
    assert.deepEqual(billingCountryOptions({ country: 'PH' }), ['PH', 'Philippines', '菲律宾']);
    assert.deepEqual(billingCountryOptions({ country: 'US' }), ['US', 'United States', '美国']);
    assert.deepEqual(billingCountryOptions({ country: 'CL' }), ['CL', 'Chile', '智利']);
    const wrong = await ensureCheckoutTaxFreeAmount(
      { ...page, textContent: async () => 'Total due today PHP 119.00' },
      {},
      null
    );
    assert.equal(wrong.ok, false);
  } finally {
    if (previous === undefined) delete process.env.PAYMENT_REGION_OVERRIDE;
    else process.env.PAYMENT_REGION_OVERRIDE = previous;
  }
});
