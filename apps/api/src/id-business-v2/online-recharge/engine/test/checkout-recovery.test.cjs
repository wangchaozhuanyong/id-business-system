'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const recovery = require('../checkout-recovery.cjs');
const accountId = '11111111-1111-4111-8111-111111111111';
const cardId = '22222222-2222-4222-8222-222222222222';
const jwt =
  'fixture.' +
  Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId }
    })
  ).toString('base64url') +
  '.unused';
const nativeUrl = 'https://chatgpt.com/checkout/openai_llc/oaics_fixtureOriginalCheckout';
const hostedUrl = 'https://checkout.stripe.com/c/pay/cs_test_fixtureOriginalCheckout';
function context(url = nativeUrl) {
  return {
    kind: 'initial',
    sourcePlan: 'free',
    targetPlan: 'pro_20x',
    accountId,
    cardId,
    cardLast4: '4242',
    currency: 'PHP',
    amount: '8919.64',
    quoteId: recovery.quoteIdForUrl(url)
  };
}
function identity(url = nativeUrl) {
  return recovery.buildCheckoutRecovery(url, context(url));
}
function request(url, method = 'GET', body) {
  return {
    url,
    method,
    body,
    headers: { authorization: 'Bearer ' + jwt, 'chatgpt-account-id': accountId }
  };
}
function nativeSession() {
  return {
    checkout_session_id: identity().checkoutId,
    processor_entity: 'openai_llc',
    plan_name: 'chatgptpro',
    status: 'open',
    payment_status: 'unpaid',
    checkout_state: {
      id: identity().checkoutId,
      currency: 'PHP',
      total: { total: { minorUnitsAmount: 891964 } }
    }
  };
}
test('recovery identity binds the exact original quote, account, card and trusted checkout location', () => {
  const value = identity();
  assert.equal(value.version, 1);
  assert.equal(value.processorEntity, 'openai_llc');
  assert.equal(value.checkoutId, 'oaics_fixtureOriginalCheckout');
  assert.deepEqual(recovery.validateRecovery(value), value);
  assert.equal(recovery.sameContext(value, context()), true);
  assert.equal(recovery.sameContext(value, { ...context(), cardId: 'another-card' }), false);
  for (const url of [
    'https://evil.invalid/checkout/openai_llc/oaics_fixture',
    'https://user:password@chatgpt.com/checkout/openai_llc/oaics_fixture',
    'http://chatgpt.com/checkout/openai_llc/oaics_fixture',
    'https://chatgpt.com/auth/login'
  ]) {
    assert.throws(() => recovery.buildCheckoutRecovery(url, context()), {
      code: 'CHECKOUT_RECOVERY_INVALID'
    });
  }
  assert.throws(() => recovery.validateRecovery({ ...value, checkoutId: 'oaics_other' }));
  assert.throws(() => recovery.validateRecovery({ ...value, processorEntity: 'different' }));
  assert.throws(() =>
    recovery.buildCheckoutRecovery(nativeUrl, { ...context(), quoteId: 'quote:wrong' })
  );
});

test('payment amounts use exact integer minor units without floating-point conversion', () => {
  assert.equal(recovery.minorAmount('8919.64', 'PHP'), 891964n);
  assert.equal(recovery.minorAmount('8919.6400', 'PHP'), 891964n);
  assert.equal(recovery.minorAmount('8919.641', 'PHP'), null);
  assert.equal(recovery.minorAmount('100', 'JPY'), 100n);
  assert.equal(recovery.minorAmount('1.234', 'KWD'), 1234n);
  assert.equal(recovery.minorAmount('1e2', 'PHP'), null);
});

test('only the verified native and hosted URL contracts can persist an original recovery capability', () => {
  for (const host of ['pay.openai.com', 'checkout.stripe.com']) {
    const url = `https://${host}/c/pay/cs_test_fixtureOriginalCheckout`;
    const value = identity(url);
    assert.equal(value.processorEntity, null);
    assert.equal(value.checkoutId, 'cs_test_fixtureOriginalCheckout');
  }
  // The upstream legacy resolver can fabricate this URL when only a cs_* ID is returned.
  // That does not establish that ChatGPT supports it as a native checkout.
  assert.throws(
    () =>
      recovery.quoteIdForUrl(
        'https://chatgpt.com/checkout/openai_llc/cs_test_fixtureOriginalCheckout'
      ),
    { code: 'CHECKOUT_RECOVERY_UNSUPPORTED' }
  );
  for (const url of [
    'https://chatgpt.com/c/pay/cs_test_fixtureOriginalCheckout',
    'https://checkout.stripe.com/checkout/openai_llc/oaics_fixtureOriginalCheckout',
    'https://pay.openai.com/checkout/openai_llc/oaics_fixtureOriginalCheckout',
    'https://pay.openai.com/c/pay/prefix-cs_test_fixtureOriginalCheckout-suffix',
    'https://checkout.stripe.com/c/pay/no-session?session_id=cs_test_fixtureOriginalCheckout',
    'https://checkout.stripe.com/c/pay/cs_test_fixtureOriginalCheckout/cs_test_anotherCheckout'
  ])
    assert.throws(() => recovery.quoteIdForUrl(url), { code: 'CHECKOUT_RECOVERY_INVALID' });
  const native = identity();
  assert.throws(() => recovery.validateRecovery({ ...native, checkoutUrl: hostedUrl }));
  const hosted = identity(hostedUrl);
  assert.throws(() =>
    recovery.validateRecovery({
      ...hosted,
      checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/' + hosted.checkoutId
    })
  );
});

test('an open/unpaid original checkout and its final quote never prove payment', async () => {
  const observer = recovery.observePayment(new EventEmitter(), identity(), {
    alreadySubmitted: true
  });
  await observer.accept(
    nativeSession(),
    request('https://chatgpt.com/backend-api/payments/checkout/openai_llc/' + identity().checkoutId)
  );
  assert.equal(observer.evidence(), null);
  await observer.dispose();
});

test('only a bound complete/paid Checkout receipt with its exact actual amount and currency is accepted', async () => {
  const value = identity(hostedUrl);
  for (const changed of [
    { session_id: 'cs_test_other' },
    { amount_total: 891965 },
    { currency: 'usd' },
    { status: 'open' },
    { payment_status: 'unpaid' },
    { amount_total: '891964' }
  ]) {
    const observer = recovery.observePayment(new EventEmitter(), value, { alreadySubmitted: true });
    await observer.accept(
      {
        object: 'checkout.session',
        session_id: value.checkoutId,
        status: 'complete',
        payment_status: 'paid',
        amount_total: 891964,
        currency: 'php',
        ...changed
      },
      request('https://api.stripe.com/v1/payment_pages/' + value.checkoutId + '/init', 'POST')
    );
    assert.equal(observer.evidence(), null);
    await observer.dispose();
  }
  const observer = recovery.observePayment(new EventEmitter(), value, { alreadySubmitted: true });
  await observer.accept(
    {
      object: 'checkout.session',
      session_id: value.checkoutId,
      status: 'complete',
      payment_status: 'paid',
      amount_total: 891964,
      currency: 'php'
    },
    request('https://api.stripe.com/v1/payment_pages/' + value.checkoutId + '/init', 'POST')
  );
  assert.equal(observer.evidence().verified, true);
  assert.equal(observer.evidence().amount, '8919.64');
  assert.equal(observer.evidence().quoteId, value.quoteId);
  await observer.dispose();
});

test('a PaymentIntent must first be linked by the same checkout and actually receive the exact amount', async () => {
  const value = identity(),
    observer = recovery.observePayment(new EventEmitter(), value, { alreadySubmitted: true });
  const paid = {
    object: 'payment_intent',
    id: 'pi_fixtureBound',
    status: 'succeeded',
    amount_received: 891964,
    currency: 'php'
  };
  const intentRead = request('https://api.stripe.com/v1/payment_intents/pi_fixtureBound');
  await observer.accept(paid, intentRead);
  assert.equal(observer.evidence(), null);
  await observer.accept(
    { type: 'payment_intent', client_secret: 'pi_fixtureBound_secret_transientOnly' },
    request('https://chatgpt.com/backend-api/payments/checkout/confirm', 'POST', {
      checkout_session_id: value.checkoutId
    })
  );
  assert.equal(observer.evidence(), null);
  await observer.accept({ ...paid, amount_received: undefined, amount: 891964 }, intentRead);
  assert.equal(observer.evidence(), null);
  await observer.accept({ ...paid, id: 'pi_other' }, intentRead);
  assert.equal(observer.evidence(), null);
  await observer.accept(paid, intentRead);
  assert.equal(observer.evidence().verified, true);
  assert.equal(JSON.stringify(observer.evidence()).includes('secret'), false);
  await observer.dispose();
});

test('unrelated hosts, accounts, checkout identities and pre-submission responses are ignored', async () => {
  const value = identity(),
    observer = recovery.observePayment(new EventEmitter(), value);
  const link = { type: 'payment_intent', client_secret: 'pi_fixtureBound_secret_transientOnly' };
  const correct = request('https://chatgpt.com/backend-api/payments/checkout/confirm', 'POST', {
    checkout_session_id: value.checkoutId
  });
  await observer.accept(link, correct);
  observer.arm();
  await observer.accept(link, {
    ...correct,
    url: 'https://evil.invalid/backend-api/payments/checkout/confirm'
  });
  await observer.accept(link, { ...correct, headers: { authorization: 'Bearer invalid' } });
  await observer.accept(link, { ...correct, body: { checkout_session_id: 'oaics_other' } });
  await observer.accept(
    {
      object: 'payment_intent',
      id: 'pi_fixtureBound',
      status: 'succeeded',
      amount_received: 891964,
      currency: 'php'
    },
    request('https://api.stripe.com/v1/payment_intents/pi_fixtureBound')
  );
  assert.equal(observer.evidence(), null);
  assert.throws(() => observer.arm());
  await observer.dispose();
});

test('observation cancellation and expiration never promote incomplete receipts', async () => {
  const controller = new AbortController();
  const observer = recovery.observePayment(new EventEmitter(), identity(), {
    signal: controller.signal
  });
  controller.abort();
  assert.throws(() => observer.arm(), { code: 'LEASE_LOST' });
  assert.equal(observer.evidence(), null);
  await observer.dispose();
  const expired = recovery.observePayment(new EventEmitter(), identity(), {
    deadlineAt: performance.now() - 1
  });
  assert.throws(() => expired.arm(), { code: 'ORIGINAL_PAYMENT_READ_TIMEOUT' });
  await expired.dispose();
});

test('legacy or mismatched recovery data stops without creating a browser or a financial request', async () => {
  assert.equal(
    (await recovery.recoverOriginalPayment(null)).reason,
    'LEGACY_ORIGINAL_IDENTITY_MISSING'
  );
  assert.equal((await recovery.recoverOriginalPayment({})).reason, 'CHECKOUT_RECOVERY_INVALID');
  assert.equal(
    (
      await recovery.recoverOriginalPayment(identity(), {
        paymentContext: { ...context(), amount: '9990' }
      })
    ).reason,
    'CHECKOUT_RECOVERY_INVALID'
  );
});

test('real Chromium recovery only reads the same original checkout and blocks page-initiated writes', async () => {
  const { chromium } = require('../upstream/node_modules/playwright');
  const browser = await chromium.launch({ headless: true });
  const seen = [],
    prepared = [],
    contexts = [];
  const rawSource = fs.readFileSync(path.join(__dirname, '../checkout-recovery.cjs'), 'utf8');
  const module = { exports: {} };
  let usedPage;
  try {
    runInNewContext(rawSource, {
      module,
      Buffer,
      URL,
      process: { env: { PROXY: 'http://fixed-task-proxy.invalid:8123' } },
      require(name) {
        if (name.startsWith('node:')) return require(name);
        if (name === './plans.cjs') return require('../plans.cjs');
        if (name === './rpc.cjs') return {};
        if (name === './upstream/playwright-proxy')
          return {
            preparePlaywrightProxy: async (value) => {
              prepared.push(value);
              return { proxyConfig: undefined, cleanup: async () => {} };
            }
          };
        if (name === './upstream/human-verification')
          return {
            prepareVerificationPage: async () => {},
            disposeVerificationPage: async () => {}
          };
        if (name === './upstream/browser-runtime')
          return {
            connectTaskBrowser: async () => ({
              browser: {
                newContext: async () => {
                  const context = await browser.newContext();
                  contexts.push(context);
                  await context.route('**/*', async (route) => {
                    const req = route.request();
                    seen.push({ url: req.url(), method: req.method() });
                    if (!req.url().startsWith('https://chatgpt.com/')) return route.abort();
                    if (req.url().includes('/backend-api/payments/checkout/'))
                      return route.fulfill({
                        contentType: 'application/json',
                        body: JSON.stringify(nativeSession())
                      });
                    return route.fulfill({
                      contentType: 'text/html',
                      body: '<html><body>Fixture<script>fetch("/backend-api/payments/checkout",{method:"POST"}).catch(()=>{});</script></body></html>'
                    });
                  });
                  return context;
                }
              }
            }),
            closeTaskBrowser: async () => {}
          };
        if (name === './upstream/session-auth')
          return {
            installChatGptSession: async () => ({ sessionData: {} }),
            bootstrapChatGptSession: async (page) => {
              usedPage = page;
              await page.goto('https://chatgpt.com/');
              return { session: { accessToken: jwt } };
            },
            extractAccessTokenFromRaw: () => jwt
          };
        throw new Error('Unexpected fixture import ' + name);
      }
    });
    const result = await module.exports.recoverOriginalPayment(identity(), {
      sessionRaw: 'synthetic-only',
      paymentContext: context(),
      confirmSubscription: async ({ page, browserContext }) => {
        assert.equal(page, usedPage);
        assert.equal(browserContext, contexts[0]);
        return { querySucceeded: true, verified: false };
      }
    });
    assert.equal(result.reason, 'ORIGINAL_PAYMENT_EVIDENCE_MISSING');
    assert.equal(result.paymentEvidence, null);
    assert.equal(result.confirmation.querySucceeded, true);
    assert.equal(prepared.length, 1);
    assert.equal(seen.filter((r) => r.method !== 'GET').length, 0);
    assert.ok(
      seen.some((r) =>
        r.url.endsWith('/backend-api/payments/checkout/openai_llc/' + identity().checkoutId)
      )
    );
    assert.equal(contexts[0].pages().length, 0);
  } finally {
    await browser.close();
  }
});
