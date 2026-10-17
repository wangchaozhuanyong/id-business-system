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
const embeddedUrl = 'https://chatgpt.com/checkout/openai_ie/cs_live_fixtureOriginalCheckout';
const embeddedSource = {
  kind: 'official_checkout_response',
  checkoutId: 'cs_live_fixtureOriginalCheckout',
  processorEntity: 'openai_ie'
};
function context(url = nativeUrl, source) {
  return {
    kind: 'initial',
    sourcePlan: 'free',
    targetPlan: 'pro_20x',
    accountId,
    cardId,
    cardLast4: '4242',
    currency: 'PHP',
    amount: '8919.64',
    quoteId: recovery.quoteIdForUrl(url, source)
  };
}
function identity(url = nativeUrl, source) {
  return recovery.buildCheckoutRecovery(url, context(url, source), source);
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

test('embedded Stripe checkout requires the exact official response source retained on the same page', () => {
  const page = {},
    otherPage = {};
  recovery.rememberOfficialCheckout(page, embeddedSource);
  const source = recovery.officialCheckoutForPage(page);
  const value = identity(embeddedUrl, source);
  assert.deepEqual(value.source, embeddedSource);
  assert.equal(value.processorEntity, 'openai_ie');
  assert.deepEqual(recovery.validateRecovery(value), value);
  assert.equal(recovery.officialCheckoutForPage(otherPage), undefined);
  source.processorEntity = 'changed';
  assert.equal(recovery.officialCheckoutForPage(page).processorEntity, 'openai_ie');
  for (const changed of [
    undefined,
    { ...embeddedSource, checkoutId: 'cs_live_other' },
    { ...embeddedSource, processorEntity: 'openai_llc' },
    { ...embeddedSource, kind: 'guessed' },
    { ...embeddedSource, extra: true }
  ]) {
    assert.throws(() => recovery.quoteIdForUrl(embeddedUrl, changed), {
      code: 'CHECKOUT_RECOVERY_UNSUPPORTED'
    });
  }
  assert.throws(() =>
    recovery.quoteIdForUrl(
      embeddedUrl.replace('fixtureOriginalCheckout', 'anotherCheckout'),
      embeddedSource
    )
  );
  assert.throws(() => recovery.validateRecovery({ ...value, source: undefined }));
  recovery.rememberOfficialCheckout(page, null);
  assert.equal(recovery.officialCheckoutForPage(page), undefined);
});

test('read-only recovery permits only the same Stripe initialization with bounded read parameters', () => {
  const value = identity(embeddedUrl, embeddedSource);
  const req = (url, body = '', method = 'POST') => ({
    url: () => url,
    method: () => method,
    postData: () => body
  });
  const url = `https://api.stripe.com/v1/payment_pages/${value.checkoutId}/init`;
  const allowed = (request) => recovery.readOnlyRecoveryRequest(request, value);
  assert.equal(allowed(req(url)), true);
  assert.equal(
    allowed(
      req(url, 'key=pk_test_synthetic&browser_locale=en-US&redirect_type=url&eid=fixture_123')
    ),
    true
  );
  for (const body of [
    'billing=changed',
    'payment_method=pm_fixture',
    'confirm=true',
    'unknown=1',
    'key=sk_test_secret',
    'browser_locale=en-US&browser_locale=fr',
    'x'.repeat(16001)
  ])
    assert.equal(allowed(req(url, body)), false);
  for (const changed of [
    url.replace(value.checkoutId, 'cs_live_other'),
    url.replace('/init', '/confirm'),
    url.replace('api.stripe.com', 'evil.invalid'),
    url + '?key=pk_test_first'
  ]) {
    assert.equal(allowed(req(changed, 'key=pk_test_second')), false);
  }
  for (const target of [
    'https://chatgpt.com/backend-api/payments/checkout',
    'https://chatgpt.com/backend-api/payments/checkout/confirm',
    'https://api.stripe.com/v1/payment_methods'
  ])
    assert.equal(allowed(req(target)), false);
  assert.equal(allowed(req(url, '', 'DELETE')), false);
});

test('Stripe total_summary due is actual payment evidence only when every returned amount agrees', async () => {
  const value = identity(embeddedUrl, embeddedSource);
  const receipt = {
    object: 'checkout.session',
    id: 'internal-object-id',
    session_id: value.checkoutId,
    status: 'complete',
    payment_status: 'paid',
    total_summary: { due: 891964 },
    currency: 'php'
  };
  for (const changed of [
    { total_summary: { due: 0 } },
    { total_summary: { due: '891964' } },
    { amount_total: 891965 },
    { status: 'open' },
    { payment_status: 'unpaid' },
    { currency: 'usd' },
    { session_id: 'cs_live_other' },
    { session_id: null, id: value.checkoutId },
    { session_id: '', id: value.checkoutId },
    { session_id: 'cs_live_other', id: value.checkoutId }
  ]) {
    const observer = recovery.observePayment(new EventEmitter(), value, { alreadySubmitted: true });
    await observer.accept(
      { ...receipt, ...changed },
      request(`https://api.stripe.com/v1/payment_pages/${value.checkoutId}/init`, 'POST')
    );
    assert.equal(observer.evidence(), null);
    await observer.dispose();
  }
  const observer = recovery.observePayment(new EventEmitter(), value, { alreadySubmitted: true });
  await observer.accept(
    receipt,
    request(`https://api.stripe.com/v1/payment_pages/${value.checkoutId}/init`, 'POST')
  );
  const first = observer.evidence();
  assert.equal(first.verified, true);
  await observer.accept(
    { ...receipt, amount_total: 891964 },
    request(`https://api.stripe.com/v1/payment_pages/${value.checkoutId}/init`, 'POST')
  );
  assert.equal(observer.evidence(), first);
  await observer.dispose();
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

function checkoutServiceFixture(options = {}) {
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(path.join(__dirname, '../upstream/chatgpt.js'), 'utf8'), {
    module,
    URL,
    process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'axios' || name === './payment-retry') return {};
      if (name === './mysql-store')
        return { resolvePlanName: () => options.planName ?? 'chatgptpro' };
      if (name === './region-config') return { getRegionConfig: () => ({ currency: 'PHP' }) };
      if (name === './session-auth') return {};
      if (name === './auth-page-detect')
        return {
          isCheckoutLoginGate: async () => options.loginGate === true,
          hasVisibleLoginChrome: async () => false,
          buildSessionNotLoggedInError: () => 'Synthetic login required'
        };
      if (name === './human-verification')
        return {
          clearHumanVerification: async () => ({ cleared: false, checkoutNotReady: true }),
          buildCaptchaRequiredError: () => 'Synthetic verification not ready'
        };
      if (name === '../checkout-recovery.cjs') return recovery;
      throw new Error('Unexpected fixture import ' + name);
    }
  });
  return module.exports;
}
test('Checkout API resolver never guesses an entity, scans unrelated JSON, or changes the explicit session', () => {
  const Service = checkoutServiceFixture();
  const resolver = new Service(null, 'synthetic-only');
  assert.equal(
    resolver.resolveCheckoutUrl({ checkout_session_id: embeddedSource.checkoutId }).checkoutUrl,
    null
  );
  assert.equal(
    resolver.resolveCheckoutUrl({
      nested: { any: embeddedSource.checkoutId },
      processor_entity: 'openai_ie'
    }).checkoutUrl,
    null
  );
  const resolved = resolver.resolveCheckoutUrl({
    checkout_session_id: embeddedSource.checkoutId,
    processor_entity: 'openai_ie'
  });
  assert.equal(resolved.checkoutUrl, embeddedUrl);
  assert.equal(JSON.stringify(resolved.checkoutSource), JSON.stringify(embeddedSource));
  for (const data of [
    {
      checkout_session_id: embeddedSource.checkoutId,
      processor_entity: 'openai_llc',
      url: embeddedUrl
    },
    {
      checkout_session_id: embeddedSource.checkoutId,
      session_id: 'cs_live_other',
      processor_entity: 'openai_ie'
    },
    {
      checkout_session_id: embeddedSource.checkoutId,
      processor_entity: 'openai_ie',
      url: 'https://evil.invalid/'
    },
    { checkout_session_id: 'cs_test_explicit', url: hostedUrl },
    { url: 'https://checkout.stripe.com/not-a-checkout' },
    { url: hostedUrl + '/cs_test_other' },
    { checkout_session_id: 'not-a-session', url: hostedUrl }
  ])
    assert.equal(resolver.resolveCheckoutUrl(data).checkoutUrl, null);
  assert.equal(
    resolver.resolveCheckoutUrl({ url: hostedUrl }).sessionId,
    'cs_test_fixtureOriginalCheckout'
  );
  const hostedWithoutEntity = resolver.resolveCheckoutUrl({
    url: hostedUrl,
    processor_entity: null
  });
  assert.equal(hostedWithoutEntity.checkoutUrl, hostedUrl);
  assert.equal(hostedWithoutEntity.processorEntity, null);
  assert.equal(
    resolver.resolveCheckoutUrl({
      checkout_session_id: 'oaics_fixture',
      processor_entity: 'openai_ie'
    }).checkoutUrl,
    'https://chatgpt.com/checkout/openai_ie/oaics_fixture'
  );
});

for (const [label, data] of [
  ['URL only', { url: embeddedUrl }],
  ['explicit id and URL', { checkout_session_id: embeddedSource.checkoutId, url: embeddedUrl }],
  [
    'matching explicit fields and URL',
    {
      checkout_session_id: embeddedSource.checkoutId,
      session_id: embeddedSource.checkoutId,
      processor_entity: embeddedSource.processorEntity,
      url: embeddedUrl
    }
  ]
]) {
  test(`an official complete Checkout response (${label}) supplies its exact path identity and source`, async () => {
    const Service = checkoutServiceFixture();
    let postCalls = 0;
    const page = {
      context: () => ({
        request: {
          post: async () => {
            postCalls++;
            return { status: () => 200, text: async () => JSON.stringify(data) };
          }
        }
      })
    };
    const opened = await Service.openApiCheckout(page, {
      accessToken: 'synthetic-only',
      planType: 'pro_20x',
      country: 'PH',
      currency: 'PHP',
      verifyPage: false
    });
    assert.equal(opened.checkoutUrl, embeddedUrl);
    assert.equal(opened.sessionId, embeddedSource.checkoutId);
    assert.deepEqual(recovery.officialCheckoutForPage(page), embeddedSource);
    assert.equal(postCalls, 1);
  });
}

test('an official URL cannot conceal conflicting, null, empty or invalid explicit identity fields', () => {
  const Service = checkoutServiceFixture();
  const resolver = new Service(null, 'synthetic-only');
  for (const fields of [
    { checkout_session_id: null },
    { checkout_session_id: undefined },
    { checkout_session_id: '' },
    { checkout_session_id: 'not-a-session' },
    { checkout_session_id: 'cs_live_other' },
    { session_id: null },
    { session_id: '' },
    { session_id: 'cs_live_other' },
    { checkout_session_id: embeddedSource.checkoutId, session_id: 'cs_live_other' },
    { processor_entity: null },
    { processor_entity: undefined },
    { processor_entity: '' },
    { processor_entity: 'invalid-entity' },
    { processor_entity: 'openai_llc' }
  ])
    assert.equal(resolver.resolveCheckoutUrl({ url: embeddedUrl, ...fields }).checkoutUrl, null);
});

test('URL-only identity extraction rejects foreign origins and noncanonical checkout paths', () => {
  const Service = checkoutServiceFixture();
  const resolver = new Service(null, 'synthetic-only');
  for (const url of [
    embeddedUrl.replace('https:', 'http:'),
    embeddedUrl.replace('chatgpt.com', 'chatgpt.com.evil.invalid'),
    embeddedUrl.replace('chatgpt.com', 'user:password@chatgpt.com'),
    embeddedUrl.replace('chatgpt.com', 'chatgpt.com:9443'),
    embeddedUrl.replace('/checkout/', '/other/'),
    embeddedUrl + '/confirm',
    embeddedUrl.replace('openai_ie', 'OpenAI_IE'),
    embeddedUrl + '%2fconfirm',
    embeddedUrl + '/cs_test_anotherCheckout'
  ])
    assert.equal(resolver.resolveCheckoutUrl({ url }).checkoutUrl, null);
});

test('the actual API checkout opener records only its returned official source and rejects incomplete 200 replies', async () => {
  const Service = checkoutServiceFixture();
  const page = (data) => ({
    context: () => ({
      request: { post: async () => ({ status: () => 200, text: async () => JSON.stringify(data) }) }
    })
  });
  const original = page({
    checkout_session_id: embeddedSource.checkoutId,
    processor_entity: 'openai_ie'
  });
  const options = {
    accessToken: 'synthetic-only',
    planType: 'pro_20x',
    country: 'PH',
    currency: 'PHP',
    verifyPage: false
  };
  const opened = await Service.openApiCheckout(original, options);
  assert.equal(opened.checkoutUrl, embeddedUrl);
  assert.deepEqual(recovery.officialCheckoutForPage(original), embeddedSource);
  const incomplete = page({ checkout_session_id: 'cs_test_noEntity' });
  await assert.rejects(Service.openApiCheckout(incomplete, options), {
    code: 'CHECKOUT_RECOVERY_INVALID'
  });
  assert.equal(recovery.officialCheckoutForPage(incomplete), undefined);
});

test('an invalid successful creation response cannot fall back to a second UI checkout', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../upstream/index.js'), 'utf8');
  const start = source.indexOf('        // --- Phase 2: API 创建 Checkout');
  const end = source.indexOf('\n        if (debugOnly)', start);
  assert.ok(start > 0 && end > start);
  for (const code of ['CHECKOUT_RECOVERY_INVALID', 'CHECKOUT_RECOVERY_UNSUPPORTED']) {
    let apiCalls = 0,
      uiCalls = 0;
    const promise = runInNewContext('(async()=>{' + source.slice(start, end) + '})()', {
      process: { env: { CHECKOUT_MODE: 'api' } },
      page: {},
      operation: 'initial',
      planType: 'pro_20x',
      billingCountry: 'PH',
      billingCurrency: 'PHP',
      CONFIG: {},
      loginInfo: { session: {} },
      debugOnly: false,
      console: { warn() {}, log() {} },
      openApiCheckout: async () => {
        apiCalls++;
        throw Object.assign(new Error('synthetic-only'), { code });
      },
      openPricingCheckout: async () => {
        uiCalls++;
        return {};
      }
    });
    await assert.rejects(promise, { code });
    assert.equal(apiCalls, 1);
    assert.equal(uiCalls, 0);
  }
});

function checkoutPhaseFixture(page, Service) {
  const source = fs.readFileSync(path.join(__dirname, '../upstream/index.js'), 'utf8');
  const start = source.indexOf('        // --- Phase 2: API 创建 Checkout');
  const end = source.indexOf('\n        if (debugOnly)', start);
  let uiCalls = 0;
  const pending = runInNewContext('(async()=>{' + source.slice(start, end) + '})()', {
    process: { env: { CHECKOUT_MODE: 'api' } },
    page,
    operation: 'initial',
    planType: 'pro_20x',
    billingCountry: 'PH',
    billingCurrency: 'PHP',
    CONFIG: {},
    loginInfo: { session: { accessToken: 'synthetic-only' } },
    debugOnly: false,
    console: { warn() {}, log() {} },
    openApiCheckout: (...args) => Service.openApiCheckout(...args),
    openPricingCheckout: async () => {
      uiCalls++;
      return {};
    }
  });
  return { pending, uiCalls: () => uiCalls };
}

for (const failure of ['navigation timeout', 'login gate', 'page verification']) {
  test(`an accepted API checkout followed by ${failure} never creates another UI checkout`, async () => {
    const Service = checkoutServiceFixture({ loginGate: failure === 'login gate' });
    let apiCalls = 0,
      openedUrl;
    const page = {
      context: () => ({
        request: {
          post: async () => {
            apiCalls++;
            return {
              status: () => 200,
              text: async () =>
                JSON.stringify({
                  checkout_session_id: embeddedSource.checkoutId,
                  processor_entity: embeddedSource.processorEntity
                })
            };
          }
        }
      }),
      goto: async (url) => {
        openedUrl = url;
        if (failure === 'navigation timeout')
          throw Object.assign(new Error('Synthetic navigation timeout'), { name: 'TimeoutError' });
      },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      title: async () => 'Synthetic page',
      url: () => embeddedUrl
    };
    const phase = checkoutPhaseFixture(page, Service);
    await assert.rejects(phase.pending, {
      code: 'CHECKOUT_OPEN_FAILED',
      checkoutCreationState: 'accepted'
    });
    assert.equal(apiCalls, 1);
    assert.equal(phase.uiCalls(), 0);
    assert.equal(openedUrl, embeddedUrl);
    assert.deepEqual(recovery.officialCheckoutForPage(page), embeddedSource);
  });
}

for (const status of ['network unknown', 400, 500]) {
  test(`a sent checkout POST with ${status} does not trigger another UI creation`, async () => {
    const Service = checkoutServiceFixture();
    let apiCalls = 0,
      navigations = 0;
    const page = {
      context: () => ({
        request: {
          post: async () => {
            apiCalls++;
            if (status === 'network unknown')
              throw Object.assign(new Error('Synthetic reset after POST'), { code: 'ECONNRESET' });
            return { status: () => status, text: async () => '{"detail":"Synthetic rejection"}' };
          }
        }
      }),
      goto: async () => {
        navigations++;
      }
    };
    const phase = checkoutPhaseFixture(page, Service);
    await assert.rejects(phase.pending, {
      code: status === 400 ? 'CHECKOUT_CREATION_REJECTED' : 'CHECKOUT_CREATION_UNKNOWN',
      checkoutCreationState: status === 400 ? 'rejected' : 'unknown'
    });
    assert.equal(apiCalls, 1);
    assert.equal(phase.uiCalls(), 0);
    assert.equal(navigations, 0);
  });
}

test('only a local preparation failure proven before POST retains the existing UI fallback', async () => {
  const Service = checkoutServiceFixture({ planName: '' });
  let apiCalls = 0;
  const page = {
    context: () => ({
      request: {
        post: async () => {
          apiCalls++;
          throw new Error('No POST should be sent');
        }
      }
    })
  };
  const phase = checkoutPhaseFixture(page, Service);
  await phase.pending;
  assert.equal(apiCalls, 0);
  assert.equal(phase.uiCalls(), 1);
});
