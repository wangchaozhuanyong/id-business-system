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

test('不付款报告保留准备状态和控件读取诊断，移除未允许的正文及链接', () => {
  const snapshot = () => ({
    format: 'unpaid-validation-v1',
    startedAt: new Date().toISOString(),
    timeline: [{ stage: 'checkout_open', startedAt: new Date().toISOString() }]
  });
  const preparing = validation.finish(
    {
      errorCode: 'CHECKOUT_PLAN_PREPARING',
      checkoutOpenDiagnostics: {
        stage: 'readiness',
        reason: 'not_ready',
        code: 'CHECKOUT_PLAN_PREPARING',
        rawBody: 'private diagnostic text',
        checkoutUrl: 'https://example.invalid/private'
      }
    },
    snapshot()
  );
  assert.equal(preparing.failureClass, 'PAYMENT_COMPONENT_NOT_LOADED');
  assert.equal(preparing.failureCode, 'CHECKOUT_PLAN_PREPARING');
  assert.equal(preparing.checkoutOpenDiagnostics.code, 'CHECKOUT_PLAN_PREPARING');
  assert.equal(JSON.stringify(preparing).includes('private'), false);
  const incomplete = validation.finish(
    {
      errorCode: 'CHECKOUT_CONTROL_READ_FAILED',
      checkoutOpenDiagnostics: {
        stage: 'readiness',
        reason: 'not_ready',
        code: 'CHECKOUT_CONTROL_READ_FAILED',
        inspection: {
          complete: false,
          framesFailed: 1,
          framesChecked: 0,
          framesSkipped: 0,
          timedOut: true,
          aborted: false,
          pageClosed: false,
          readPhase: 'frame_scan'
        }
      }
    },
    snapshot()
  );
  assert.equal(incomplete.failureClass, 'READ_INCOMPLETE');
  assert.equal(incomplete.checkoutOpenDiagnostics.inspection.complete, false);
  assert.equal(incomplete.checkoutOpenDiagnostics.inspection.framesFailed, 1);
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
  assert.equal(actual.failure, '', 'fixture RPC must accept the independent debug protocol');
  assert.equal(
    actual.result.status,
    'succeeded',
    JSON.stringify({
      code: actual.result.result?.errorCode,
      failureClass: actual.result.result?.validationReport?.failureClass,
      lastStage: actual.result.result?.validationReport?.lastStage
    })
  );
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

test('form read diagnostics survive preparation, classification and ordinary result projection', async () => {
  const inspection = {
    complete: false,
    framesFailed: 1,
    framesChecked: 2,
    readAttempts: 2,
    readPhase: 'candidate_eligibility',
    readFailures: [{ phase: 'control_snapshot', reason: 'timeout', count: 1 }],
    rawValue: 'PRIVATE_SECRET'
  };
  const formDiagnostics = {
    inspection,
    steps: [
      { field: 'number', phase: 'readback', state: 'completed', matched: true },
      {
        field: 'expiry',
        phase: 'precheck',
        state: 'failed',
        frameId: 2,
        frameKind: 'embedded',
        candidateCount: 1,
        readPhase: 'candidate_eligibility',
        errorClass: 'timeout',
        durationMs: 300,
        rawValue: 'PRIVATE_SECRET'
      }
    ]
  };
  validation.start();
  const fakeCard = {
    id: 'fixture',
    card_number: '4242424242424242',
    card_expiry: '12/30',
    card_cvc: '123',
    card_holder: 'Synthetic',
    billing_address: { country: 'PH', line1: 'Synthetic', city: 'Synthetic', postal_code: '1000' }
  };
  let captured;
  try {
    await validation.prepare(
      {},
      {
        store: { reserveCard: async () => fakeCard, releaseCard: async () => {} },
        payment: { prepareCheckoutCardSection: async () => {} },
        form: {
          fillCard: async () => ({
            ok: false,
            errorCode: 'CHECKOUT_CONTROL_READ_FAILED',
            missing: ['expiry', 'cvc'],
            inspection,
            formDiagnostics
          })
        }
      }
    );
    assert.fail('must stop before billing and button checks');
  } catch (error) {
    captured = error;
  }
  assert.equal(captured.formDiagnostics, formDiagnostics);
  const report = validation.finish({
    validationErrorCode: captured.code,
    validationMissing: captured.missing,
    formDiagnostics: validation.safeFormDiagnostics(captured.formDiagnostics)
  });
  const projected = require('../security.cjs').sanitizeResult({
    validationReport: report
  }).validationReport;
  assert.equal(projected.failureClass, 'READ_INCOMPLETE');
  assert.equal(projected.formDiagnostics.inspection.readPhase, 'candidate_eligibility');
  assert.deepEqual(projected.formDiagnostics.inspection.readFailures, [
    { phase: 'control_snapshot', reason: 'timeout', count: 1 }
  ]);
  assert.equal(projected.formDiagnostics.steps.at(-1).field, 'expiry');
  assert.equal(projected.formDiagnostics.steps.at(-1).phase, 'precheck');
  assert.equal(
    projected.formDiagnostics.steps.some((row) => row.field === 'cvc'),
    false
  );
  assert.equal(JSON.stringify(projected).includes('PRIVATE_SECRET'), false);
  assert.equal(projected.submitted, false);
  assert.match(validation.message(projected), /有效期／交互前检查／读取超时/);
  assert.equal(
    validation.classify({ code: 'CHECKOUT_CONTROL_READ_FAILED' }, 'card_fill'),
    'READ_INCOMPLETE'
  );
});

test('native task child retains filling diagnostics through index catch and result', async () => {
  const harness = require('./recharge-flow-acceptance.test.cjs');
  const task = harness.syntheticTask('success');
  task.operation = 'debug';
  task.payload.validationMode = 'ready_before_payment';
  const actual = await harness.runSyntheticRecharge('success', { task, formReadFailure: true });
  assert.equal(actual.failure, '');
  assert.equal(actual.result.status, 'failed');
  const report = actual.result.result.validationReport;
  assert.equal(report.failureCode, 'CHECKOUT_CONTROL_READ_FAILED');
  assert.equal(report.failureClass, 'READ_INCOMPLETE');
  assert.equal(report.formDiagnostics.inspection.readPhase, 'candidate_eligibility');
  assert.equal(report.formDiagnostics.steps.at(-1).field, 'expiry');
  assert.equal(report.formDiagnostics.steps.at(-1).phase, 'precheck');
  assert.equal(JSON.stringify(report).includes('PRIVATE_RAW_ERROR'), false);
  assert.equal(report.submitted, false);
  assert.equal(actual.metrics.checkoutCreations, 1);
  assert.equal(actual.metrics.actualPaymentClicks, 0);
  assert.equal(actual.metrics.paymentRequests, 0);
});

test('form report caps step history and discards selectors, values and raw exceptions', () => {
  const safe = validation.safeFormDiagnostics({
    steps: Array.from({ length: 60 }, (_, i) => ({
      field: 'expiry',
      phase: 'precheck',
      state: 'failed',
      durationMs: i,
      selector: 'PRIVATE_SELECTOR',
      value: 'PRIVATE_VALUE',
      error: 'PRIVATE_ERROR'
    })),
    inspection: { complete: false, rawBody: 'PRIVATE_BODY' }
  });
  assert.equal(safe.steps.length, 32);
  assert.equal(safe.steps[0].durationMs, 28);
  assert.equal(safe.steps.at(-1).durationMs, 59);
  assert.equal(JSON.stringify(safe).includes('PRIVATE'), false);
});

for (const code of [
  'PROXY_CONNECTION_FAILED',
  'PROFILE_IDENTITY_MISSING',
  'PROFILE_PROXY_INVALID',
  'PROFILE_BUSY',
  'PROFILE_EXIT_CHANGED',
  'PROFILE_BINDING_INVALID',
  'PROFILE_DIRECTORY_INVALID',
  'PROFILE_LAUNCH_FAILED',
  'PROFILE_CLEANUP_FAILED'
])
  test(`proxy/profile failure ${code} keeps its exact controlled reason`, () => {
    const report = validation.finish(
      { validationErrorCode: code },
      {
        format: 'unpaid-validation-v1',
        startedAt: '2026-10-25T08:26:28.000Z',
        timeline: [{ stage: 'proxy', startedAt: '2026-10-25T08:26:28.000Z' }]
      }
    );
    assert.equal(report.failureCode, code);
    assert.equal(
      report.failureClass,
      ['PROXY_CONNECTION_FAILED', 'PROFILE_PROXY_INVALID', 'PROFILE_EXIT_CHANGED'].includes(code)
        ? 'PROXY_UNAVAILABLE'
        : 'BROWSER_PROFILE_UNAVAILABLE'
    );
    assert.equal(report.lastStage, 'proxy');
    assert.equal(report.outcome, 'failed_with_class');
    assert.equal(report.submitted, false);
    assert.doesNotMatch(validation.message(report), /其他执行异常|UNKNOWN|PROFILE_/);
    if (code === 'PROFILE_EXIT_CHANGED')
      assert.match(validation.message(report), /出口.*绑定不一致/);
    if (code === 'PROXY_CONNECTION_FAILED') assert.match(validation.message(report), /连续5次失败/);
  });

test('unknown profile-like errors remain unknown instead of entering the allowed list', () => {
  const report = validation.finish(
    { validationErrorCode: 'PROFILE_PRIVATE_ARBITRARY' },
    {
      format: 'unpaid-validation-v1',
      startedAt: '2026-10-25T08:26:28.000Z',
      timeline: [{ stage: 'proxy', startedAt: '2026-10-25T08:26:28.000Z' }]
    }
  );
  assert.equal(report.failureCode, 'UNKNOWN');
  assert.equal(report.failureClass, 'OTHER');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ARBITRARY/);
});

for (const code of ['PROFILE_EXIT_CHANGED', 'PROFILE_LAUNCH_FAILED', 'PROXY_CONNECTION_FAILED'])
  test(`native task child propagates ${code} without checkout or payment`, async () => {
    const harness = require('./recharge-flow-acceptance.test.cjs');
    const task = harness.syntheticTask('success');
    task.operation = 'debug';
    task.payload.validationMode = 'ready_before_payment';
    const actual = await harness.runSyntheticRecharge('success', { task, profileFailure: code });
    assert.equal(actual.failure, '');
    assert.equal(actual.result.status, 'failed');
    const report = actual.result.result.validationReport;
    assert.equal(report.failureCode, code);
    assert.equal(report.lastStage, 'proxy');
    assert.notEqual(report.failureClass, 'OTHER');
    assert.equal(report.submitted, false);
    assert.equal(actual.metrics.checkoutCreations, 0);
    assert.equal(actual.metrics.actualPaymentClicks, 0);
    assert.equal(actual.metrics.paymentRequests, 0);
  });
