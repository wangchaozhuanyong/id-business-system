'use strict';
/* global window */
const test = require('node:test');
const assert = require('node:assert/strict');
const validation = require('../unpaid-validation.cjs');
const rpc = require('../rpc.cjs');
const diagnostic = require('../checkout-creation-diagnostics.cjs');
const auth = require('../upstream/auth-page-detect');
const { openApiCheckout } = require('../upstream/chatgpt');
const { chromium } = require('../upstream/node_modules/playwright');

test('mode is opt-in and cannot turn a recharge into a debug result', () => {
  assert.equal(
    validation.enabled({ operation: 'debug', payload: { validationMode: 'ready_before_payment' } }),
    true
  );
  for (const task of [
    { operation: 'debug' },
    { operation: 'recharge', payload: { validationMode: 'ready_before_payment' } }
  ])
    assert.equal(validation.enabled(task), false);
});

for (const [httpStatus, body, expected] of [
  [400, { error: { code: 'not_eligible' } }, 'NOT_ELIGIBLE'],
  [403, { error: { message: 'private arbitrary response' } }, 'UNKNOWN'],
  [403, { error: { code: 'unsupported_country' } }, 'POLICY_OR_REGION_BLOCK'],
  [429, { error: { type: 'rate_limit_error' } }, 'RATE_LIMITED']
])
  test(`checkout HTTP ${httpStatus} keeps controlled diagnostics through native creation`, async () => {
    const response = {
      status: () => httpStatus,
      text: async () => JSON.stringify(body),
      headers: () => ({ 'content-type': 'application/json' })
    };
    const page = { context: () => ({ request: { post: async () => response } }) };
    await assert.rejects(
      openApiCheckout(page, {
        accessToken: 'fixture',
        planType: 'plus',
        country: 'PH',
        currency: 'PHP'
      }),
      (error) => {
        assert.equal(error.checkoutCreationDiagnostics.httpStatus, httpStatus);
        assert.equal(error.checkoutCreationDiagnostics.classification, expected);
        assert.equal(JSON.stringify(error.checkoutCreationDiagnostics).includes('private'), false);
        if (httpStatus === 403 && expected === 'UNKNOWN')
          assert.match(
            diagnostic.message(error.checkoutCreationDiagnostics),
            /HTTP 403，原因未确认/
          );
        return true;
      }
    );
  });

test('an actual challenge response is distinct from a generic HTTP 403', () => {
  assert.equal(
    diagnostic.create(403, { 'cf-mitigated': 'challenge' }, '').classification,
    'CF_CHALLENGE'
  );
  assert.equal(
    validation.classify({
      checkoutCreationDiagnostics: diagnostic.create(403, {}, '{}'),
      errorCode: 'CHECKOUT_CREATION_REJECTED'
    }),
    'CHECKOUT_REJECTED'
  );
  assert.equal(
    validation.classify({
      checkoutCreationDiagnostics: diagnostic.create(403, { 'cf-mitigated': 'challenge' }, '')
    }),
    'CHALLENGE_BLOCKED'
  );
});

test('login DOM read failure is never absence even without diagnostic wrapper', async () => {
  const broken = {
    evaluateAll: async () => {
      throw new Error('private locator error');
    }
  };
  const page = { getByRole: () => broken };
  await assert.rejects(
    auth.hasVisibleLoginChrome(page),
    (error) => error.code === 'CHECKOUT_AUTH_READ_FAILED' && error.readClass === 'read_failed'
  );
});

test('read incomplete takes precedence over a zero candidate at card stage', () => {
  assert.equal(
    validation.classify(
      { inspection: { complete: false }, errorCode: 'CHECKOUT_CONTROL_READ_FAILED' },
      'card_fill'
    ),
    'READ_INCOMPLETE'
  );
  assert.equal(
    validation.classify({ code: 'PENDING_CREDENTIALS' }, 'card_readiness'),
    'INPUT_MISSING'
  );
  assert.equal(
    validation.classify(
      { bootstrapDiagnostics: { challengeDetected: true }, code: 'CHECKOUT_AUTH_READ_FAILED' },
      'login'
    ),
    'LOGIN_READ_FAILED'
  );
});

test('report keeps ISO times through the ordinary result sanitizer', () => {
  validation.start();
  validation.stage('login');
  validation.stage('cleanup');
  const report = validation.finish({ code: 'CHECKOUT_AUTH_READ_FAILED' });
  const safe = require('../security.cjs').sanitizeResult({
    validationReport: report
  }).validationReport;
  assert.equal(safe.lastStage, 'login');
  assert.equal(safe.failureClass, 'LOGIN_READ_FAILED');
  assert.ok(Number.isFinite(Date.parse(safe.timeline[0].startedAt)));
  assert.equal(safe.submitted, false);
});

test('automatic challenge exit never opens the human RPC queue', async () => {
  const human = require('../upstream/human-verification');
  const original = human.clearHumanVerification;
  const calls = [];
  rpc.configureTask({
    id: 'fixture',
    operation: 'debug',
    payload: { validationMode: 'ready_before_payment' }
  });
  rpc.setTransportForTest(async (method) => {
    calls.push(method);
    throw new Error('Unexpected RPC');
  });
  human.clearHumanVerification = async () => ({
    cleared: false,
    code: 'VERIFICATION_ROUNDS_EXHAUSTED'
  });
  try {
    await assert.rejects(
      require('../human-verification.cjs').waitForHumanVerification({}, {}),
      (error) => error.code === 'CHALLENGE_BLOCKED'
    );
    assert.deepEqual(calls, []);
  } finally {
    human.clearHumanVerification = original;
    rpc.setTransportForTest(null);
    rpc.clearTask();
  }
});

test('five isolated form fixtures reveal billing after card fill and never submit', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (let index = 0; index < 5; index++) {
    const context = await browser.newContext();
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(`<form onsubmit="window.submissions++;return false">
      <label>Card number<input name="cardnumber" autocomplete="cc-number"></label>
      <label>Expiry<input name="exp" autocomplete="cc-exp"></label>
      <label>Security code<input name="cvc" autocomplete="cc-csc"></label>
      <section id="billing" hidden>
        <label>Country<select name="country"><option value="PH">Philippines</option></select></label>
        <label>Full name<input name="name" autocomplete="billing name"></label>
        <label>Address line 1<input name="line1" autocomplete="address-line1"></label>
        <label>City<input name="city" autocomplete="address-level2"></label>
        <label>Postal code<input name="postal" autocomplete="postal-code"></label>
      </section><button type="submit" disabled>Subscribe</button></form>
      <script>window.submissions=0;document.querySelector('[name=cardnumber]').addEventListener('input',()=>document.querySelector('#billing').hidden=false);
      document.querySelector('form').addEventListener('input',()=>document.querySelector('button').disabled=!['line1','city','postal','name'].every(key=>document.querySelector('[name='+key+']').value));</script>`);
    const before = await page.locator('#billing').isVisible();
    assert.equal(before, false);
    const effects = { released: 0 };
    const card = {
      id: 'fixture-card',
      card_number: '4242424242424242',
      card_expiry: '10/31',
      card_cvc: '123',
      card_holder: 'Fixture Example',
      billing_address: {
        country: 'PH',
        line1: 'Fixture Street 1',
        city: 'Manila',
        postal_code: '1000'
      }
    };
    validation.start();
    const result = await validation.prepare(page, {
      store: { reserveCard: async () => card, releaseCard: async () => effects.released++ },
      payment: { prepareCheckoutCardSection: async () => {} }
    });
    assert.equal(result.validationOutcome, 'ready_before_payment');
    assert.equal(await page.evaluate(() => window.submissions), 0);
    assert.equal(effects.released, 1);
    assert.equal(rpc.wasSubmitted(), false);
    assert.equal(validation.finish(result).outcome, 'ready_before_payment');
    await context.close();
  }
});

test('actual task runner and native checkout path stop before any payment action', async () => {
  const harness = require('./recharge-flow-acceptance.test.cjs');
  const task = harness.syntheticTask('success');
  task.operation = 'debug';
  task.payload.validationMode = 'ready_before_payment';
  const actual = await harness.runSyntheticRecharge('success', { task });
  assert.equal(actual.result.status, 'succeeded');
  assert.equal(actual.result.result.validationReport.outcome, 'ready_before_payment');
  assert.equal(actual.metrics.checkoutCreations, 1);
  assert.equal(actual.metrics.actualPaymentClicks, 0);
  assert.equal(actual.metrics.paymentRequests, 0);
  assert.equal(actual.metrics.renewalRequests, 0);
  assert.equal(
    actual.actions.some((action) =>
      [
        'beforeExternalSubmit',
        'createBillingRecord',
        'recordCardUsage',
        'humanVerificationOpen'
      ].includes(action.method)
    ),
    false
  );
});

test('actual task runner classifies an unsolved visible challenge without human or payment RPCs', async () => {
  const harness = require('./recharge-flow-acceptance.test.cjs');
  const task = harness.syntheticTask('success');
  task.operation = 'debug';
  task.payload.validationMode = 'ready_before_payment';
  const actual = await harness.runSyntheticRecharge('success', { task, authUi: 'challenge' });
  assert.equal(actual.result.status, 'failed');
  assert.equal(actual.result.result.validationReport.outcome, 'challenge_blocked');
  assert.equal(actual.metrics.paymentRequests, 0);
  assert.equal(
    actual.actions.some((action) =>
      ['humanVerificationOpen', 'beforeExternalSubmit', 'reserveCard'].includes(action.method)
    ),
    false
  );
});
