'use strict';
/* global window */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { performance } = require('node:perf_hooks');
const { chromium } = require('../upstream/node_modules/playwright');
const ChatGPTService = require('../upstream/chatgpt');
const recovery = require('../checkout-recovery.cjs');

const origin = 'https://chatgpt.com';
const checkoutId = 'cs_test_browserOriginalCheckout';
const processorEntity = 'openai_fixture';
const checkoutUrl = `${origin}/checkout/${processorEntity}/${checkoutId}`;
const accountId = '11111111-1111-4111-8111-111111111111';
const cardId = '22222222-2222-4222-8222-222222222222';
const token =
  'fixture.' +
  Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
  ).toString('base64url') +
  '.unused';
const officialResponse = {
  checkout_session_id: checkoutId,
  processor_entity: processorEntity
};
const expectedSource = {
  kind: 'official_checkout_response',
  checkoutId,
  processorEntity
};
const paymentContext = {
  kind: 'initial',
  sourcePlan: 'free',
  targetPlan: 'pro_20x',
  accountId,
  cardId,
  cardLast4: '4242',
  currency: 'PHP',
  amount: '8919.64',
  quoteId: recovery.quoteIdForUrl(checkoutUrl, expectedSource)
};
const original = recovery.buildCheckoutRecovery(checkoutUrl, paymentContext, expectedSource);
const cors = { 'access-control-allow-origin': origin };
let browser;

test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
});
test.after(async () => browser?.close());

test('real browser official response carries a fixed cs source and cannot leak between pages', async (t) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const requests = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    requests.push({ method: request.method(), url: request.url() });
    if (request.method() === 'GET' && request.url() === origin + '/')
      return route.fulfill({ contentType: 'text/html', body: '<html>Fixture</html>' });
    if (request.method() === 'POST' && request.url() === origin + '/backend-api/payments/checkout')
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(officialResponse)
      });
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin);
  // The real resolver consumes a browser request/response; no APIRequestContext can bypass routes.
  const service = new ChatGPTService(
    {
      post: async (url, options) => {
        const reply = await page.evaluate(
          async ({ url, body }) => {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            });
            return { status: response.status, text: await response.text() };
          },
          { url, body: options.data }
        );
        return { status: () => reply.status, text: async () => reply.text };
      }
    },
    token
  );
  const checkout = await service.createCheckoutSession('pro_20x', 'PH', 'PHP', 'chatgptpro');
  assert.equal(checkout.checkoutUrl, checkoutUrl);
  assert.deepEqual(checkout.checkoutSource, expectedSource);
  recovery.rememberOfficialCheckout(page, checkout.checkoutSource);
  const stored = recovery.officialCheckoutForPage(page);
  assert.deepEqual(recovery.buildCheckoutRecovery(checkoutUrl, paymentContext, stored), original);
  stored.processorEntity = 'changed_after_read';
  assert.deepEqual(recovery.officialCheckoutForPage(page), expectedSource);
  const otherPage = await context.newPage();
  assert.equal(recovery.officialCheckoutForPage(otherPage), undefined);
  assert.throws(
    () =>
      recovery.buildCheckoutRecovery(
        checkoutUrl,
        paymentContext,
        recovery.officialCheckoutForPage(otherPage)
      ),
    { code: 'CHECKOUT_RECOVERY_UNSUPPORTED' }
  );
  assert.throws(() =>
    recovery.buildCheckoutRecovery(
      checkoutUrl.replace(processorEntity, 'other_entity'),
      paymentContext,
      recovery.officialCheckoutForPage(page)
    )
  );
  recovery.rememberOfficialCheckout(page, null);
  assert.equal(recovery.officialCheckoutForPage(page), undefined);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
});

function paidReceipt(change = {}) {
  return {
    id: 'ppage_fixture',
    object: 'checkout.session',
    session_id: checkoutId,
    status: 'complete',
    payment_status: 'paid',
    total_summary: { due: 891964 },
    currency: 'php',
    ...change
  };
}

async function recoverInRealBrowser(receipt) {
  const acceptedRequests = [];
  const attemptedRequests = [];
  const contexts = [];
  const preparations = [];
  let usedPage;
  const source = fs.readFileSync(path.join(__dirname, '../checkout-recovery.cjs'), 'utf8');
  const fixtureModule = { exports: {} };
  const attempts = [
    { url: '/backend-api/payments/checkout', body: 'plan_name=chatgptpro' },
    { url: '/backend-api/payments/checkout/confirm', body: 'checkout_session_id=' + checkoutId },
    { url: `https://api.stripe.com/v1/payment_pages/${checkoutId}/confirm`, body: 'confirm=true' },
    {
      url: `https://api.stripe.com/v1/payment_pages/${checkoutId}/update`,
      body: 'billing=changed'
    },
    { url: `https://api.stripe.com/v1/payment_pages/${checkoutId}/init`, body: 'billing=changed' },
    { url: 'https://api.stripe.com/v1/payment_methods', body: 'type=card' },
    { url: 'https://api.stripe.com/v1/payment_pages/cs_test_otherCheckout/init', body: '' },
    { url: 'https://untrusted.invalid/v1/payment_pages/' + checkoutId + '/init', body: '' }
  ];
  const html = `<html><body>Original checkout<script>
    window.writesFinished = Promise.allSettled(${JSON.stringify(attempts)}.map(({url,body}) =>
      fetch(url,{method:'POST',body}))).then(() => true);
    fetch(${JSON.stringify(`https://api.stripe.com/v1/payment_pages/${checkoutId}/init`)},{
      method:'POST', body:'key=pk_test_fixture&browser_locale=en-US&redirect_type=url'
    }).catch(() => {});
    </script></body></html>`;
  runInNewContext(source, {
    module: fixtureModule,
    Buffer,
    URL,
    URLSearchParams,
    process: { env: { PROXY: 'http://fixed-task-proxy.invalid:8123' } },
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === './plans.cjs') return require('../plans.cjs');
      if (name === './rpc.cjs') return {};
      if (name === './upstream/playwright-proxy')
        return {
          preparePlaywrightProxy: async (value) => {
            preparations.push(value);
            return { proxyConfig: undefined, cleanup: async () => {} };
          }
        };
      if (name === './upstream/human-verification')
        return { prepareVerificationPage: async () => {}, disposeVerificationPage: async () => {} };
      if (name === './upstream/browser-runtime')
        return {
          connectTaskBrowser: async () => ({
            browser: {
              newContext: async () => {
                const context = await browser.newContext({ serviceWorkers: 'block' });
                contexts.push(context);
                context.on('request', (request) =>
                  attemptedRequests.push({ url: request.url(), method: request.method() })
                );
                await context.route('**/*', async (route) => {
                  const request = route.request();
                  acceptedRequests.push({ url: request.url(), method: request.method() });
                  if (request.method() === 'GET' && request.url() === origin + '/')
                    return route.fulfill({
                      contentType: 'text/html',
                      body: '<html>Fixture</html>'
                    });
                  if (request.method() === 'GET' && request.url() === checkoutUrl)
                    return route.fulfill({ contentType: 'text/html', body: html });
                  if (
                    request.method() === 'POST' &&
                    request.url() === `https://api.stripe.com/v1/payment_pages/${checkoutId}/init`
                  )
                    return route.fulfill({
                      headers: cors,
                      contentType: 'application/json',
                      body: JSON.stringify(receipt)
                    });
                  return route.abort();
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
            await page.goto(origin);
            return { session: { accessToken: token } };
          },
          extractAccessTokenFromRaw: () => token
        };
      throw new Error('Unexpected fixture import ' + name);
    }
  });
  const result = await fixtureModule.exports.recoverOriginalPayment(original, {
    sessionRaw: 'synthetic-only',
    paymentContext,
    deadlineAt: performance.now() + 5000,
    confirmSubscription: async ({ page, browserContext }) => {
      assert.equal(page, usedPage);
      assert.equal(browserContext, contexts[0]);
      assert.equal(await page.evaluate(() => window.writesFinished), true);
      return { querySucceeded: true, verified: false };
    }
  });
  assert.equal(preparations.length, 1);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].pages().length, 0, 'recovery must clean up its isolated context');
  assert.ok(
    attemptedRequests.length >= attempts.length + 2,
    'fixture must actually attempt writes'
  );
  const financialRequests = acceptedRequests.filter(
    (request) => request.method === 'POST' && !request.url.endsWith(`/${checkoutId}/init`)
  );
  assert.equal(
    financialRequests.length,
    0,
    'no confirm, tokenization, update or new checkout reaches service'
  );
  assert.deepEqual(
    acceptedRequests.filter((request) => request.method === 'POST').map((request) => request.url),
    [`https://api.stripe.com/v1/payment_pages/${checkoutId}/init`],
    'only the same original checkout initialization request is allowed'
  );
  if (result.confirmation) assert.equal(result.confirmation.querySucceeded, true);
  else assert.equal(result.reason, 'ORIGINAL_PAYMENT_READ_TIMEOUT');
  return result;
}

test('real Chromium recovers an embedded cs receipt while every attempted payment and billing write is blocked', async () => {
  const result = await recoverInRealBrowser(paidReceipt());
  assert.equal(result.reason, null);
  assert.equal(result.paymentEvidence.verified, true);
  assert.equal(result.paymentEvidence.amount, '8919.64');
  assert.equal(result.paymentEvidence.currency, 'PHP');
  assert.equal(result.paymentEvidence.accountId, accountId);
  assert.equal(result.paymentEvidence.cardId, cardId);
  assert.equal(result.paymentEvidence.quoteId, original.quoteId);
});

for (const [label, change] of [
  ['unpaid original', { status: 'open', payment_status: 'unpaid' }],
  ['wrong original session', { session_id: 'cs_test_otherCheckout' }],
  ['wrong actual amount', { total_summary: { due: 891965 } }],
  ['wrong currency', { currency: 'usd' }],
  ['conflicting amount fields', { amount_total: 891965 }],
  ['string rather than exact integer amount', { total_summary: { due: '891964' } }]
])
  test(`real Chromium never promotes ${label} to paid evidence or adds a payment action`, async () => {
    const result = await recoverInRealBrowser(paidReceipt(change));
    assert.equal(result.paymentEvidence, null);
    assert.ok(
      ['ORIGINAL_PAYMENT_EVIDENCE_MISSING', 'ORIGINAL_PAYMENT_READ_TIMEOUT'].includes(result.reason)
    );
  });
