'use strict';
/* global window */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { runInNewContext } = require('node:vm');
const { chromium } = require('../upstream/node_modules/playwright');
const runtime = require('../upstream/verification-runtime');
const platform = require('../upstream/captcha-platform');
const form = require('../checkout-form.cjs');
const recovery = require('../checkout-recovery.cjs');
const { checkoutPageFlags } = require('../checkout-page-state.cjs');
const source = fs.readFileSync(path.join(__dirname, '../upstream/human-verification.js'), 'utf8');
const stripeSource = fs.readFileSync(path.join(__dirname, '../upstream/stripe-payment.js'), 'utf8');
const original = 'https://chatgpt.com/checkout/openai_llc/cs_test_loadingOriginal';
const failureHtml = '<h1>Content failed to load</h1><button>Try again</button>';
const readyHtml = '<label>Card number<input autocomplete="cc-number"></label>';
const processingErrorHtml =
  '<p>There was an error processing your payment</p><a href="https://chatgpt.com/">Return to ChatGPT</a>';
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

function human(onSolver = () => {}) {
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    URL,
    Date,
    Math,
    console: { log() {} },
    process: { env: { HEADFUL: '0' } },
    require(name) {
      if (name === './hcaptcha-solver')
        return {
          isHcaptchaSolverEnabled: () => true,
          solveHcaptchaOnPage: async () => {
            onSolver();
            throw Error('Unexpected solver');
          }
        };
      if (name === './captcha-platform')
        return { ...platform, isCaptchaPlatformEnabled: () => false };
      if (name === './verification-runtime') return runtime;
      return require(path.join(__dirname, '../upstream', name));
    }
  });
  return module.exports;
}

function stripe(verification, onSubmit, formOverride = form) {
  const module = { exports: {} };
  runInNewContext(
    stripeSource + '\nmodule.exports.clickCheckoutSubmitButton = clickCheckoutSubmitButton;',
    {
      module,
      URL,
      console: { log() {}, warn() {}, error() {} },
      process: { env: { CAPTCHA_CLEAR_TIMEOUT_MS: '8000', CHECKOUT_READY_WAIT_MS: '1000' } },
      require(name) {
        if (name === '../rpc.cjs')
          return {
            taskSignal: () => undefined,
            wasSubmitted: () => false,
            beforeExternalSubmit: async () => {
              onSubmit();
              throw Error('Unexpected submit');
            }
          };
        if (name === '../safe-media.cjs')
          return { screenshot: async () => 'synthetic-protected-image' };
        if (name === '../checkout-form.cjs') return formOverride;
        if (name === './human-verification') return verification;
        return name.startsWith('.')
          ? require(path.join(__dirname, '../upstream', name))
          : require(name);
      }
    }
  );
  return module.exports;
}

async function fixture(t, body, url = original) {
  const stats = { documents: 0, writes: 0 };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      stats.writes++;
      return route.fulfill({ status: 409, body: '{}' });
    }
    if (req.isNavigationRequest() && req.frame().parentFrame() === null) stats.documents++;
    return route.fulfill({
      contentType: 'text/html',
      body: typeof body === 'function' ? body(stats.documents, req) : body
    });
  });
  const page = await context.newPage();
  await page.goto(url);
  recovery.rememberOfficialCheckout(page, {
    kind: 'official_checkout_response',
    checkoutId: 'cs_test_loadingOriginal',
    processorEntity: 'openai_llc'
  });
  t.after(() => runtime.disposeVerificationPage(page));
  return { page, stats };
}

test('observed official terminal error stops before readiness, reload or payment', async (t) => {
  let prepare = 0,
    solver = 0;
  const { page, stats } = await fixture(t, processingErrorHtml);
  const flags = await page.evaluate(checkoutPageFlags);
  assert.equal(flags.processingError, true);
  assert.equal(flags.expired, false, 'generic processing error is not proof of expiration');
  const result = await human(() => solver++).clearHumanVerification(page, {
    requireCheckoutReady: true,
    allowCheckoutReload: true,
    maxWaitMs: 5000,
    isSubmitted: () => false,
    prepareCheckout: async () => prepare++
  });
  assert.equal(result.code, 'CHECKOUT_CONTENT_LOAD_FAILED');
  assert.equal(result.checkoutErrorPage, true);
  assert.equal(result.captchaRequired, false);
  assert.deepEqual(Array.from(result.missing), []);
  assert.equal(prepare, 0);
  assert.equal(solver, 0);
  assert.equal(stats.documents, 1);
  assert.equal(stats.writes, 0);
});

test('terminal error evidence requires both visible exact message and return control', async (t) => {
  for (const body of [
    '<p>There was an error processing your payment</p>',
    '<a href="/">Return to ChatGPT</a>',
    '<p>Example: There was an error processing your payment</p><a href="/">Return to ChatGPT</a>',
    '<div hidden>' + processingErrorHtml + '</div>',
    '<div style="opacity:0">' + processingErrorHtml + '</div>',
    '<div inert>' + processingErrorHtml + '</div>',
    '<article>' + processingErrorHtml + '</article>',
    '<section data-message-author-role="assistant">' + processingErrorHtml + '</section>'
  ]) {
    const { page } = await fixture(t, body);
    assert.equal((await page.evaluate(checkoutPageFlags)).processingError, false);
  }
});

test('terminal checkout classification excludes home and non-official origins', async (t) => {
  for (const url of [
    'https://chatgpt.com/',
    'https://chatgpt.com.attacker.invalid/checkout/fixture'
  ]) {
    const { page } = await fixture(t, processingErrorHtml, url);
    assert.equal((await page.evaluate(checkoutPageFlags)).processingError, false);
  }
});

test('hidden processing error cannot block real editable fields and no text or values leave the probe', async (t) => {
  const { page } = await fixture(
    t,
    '<div hidden>' +
      processingErrorHtml +
      '</div>' +
      readyHtml +
      '<input value="synthetic-private-canary">'
  );
  const flags = await page.evaluate(checkoutPageFlags);
  assert.equal(flags.processingError, false);
  assert.ok(Object.values(flags).every((value) => typeof value === 'boolean'));
  assert.doesNotMatch(JSON.stringify(flags), /canary|https:|processing your payment|Return to/);
  const result = await human().clearHumanVerification(page, {
    requireCheckoutReady: true,
    maxWaitMs: 4000,
    isSubmitted: () => false
  });
  assert.equal(result.cleared, true);
});

test('post-submit processing page is not reclassified as a new prepayment failure', async (t) => {
  const { page, stats } = await fixture(t, processingErrorHtml);
  const result = await human().clearHumanVerification(page, {
    requireCheckoutReady: true,
    checkoutReadyWaitMs: 500,
    maxWaitMs: 2000,
    isSubmitted: () => true
  });
  assert.equal(result.checkoutErrorPage, undefined);
  assert.equal(stats.documents, 1);
  assert.equal(stats.writes, 0);
});

test('plan, amount, pay button and an unrelated iframe cannot establish card readiness', async (t) => {
  let solverCalls = 0;
  const verification = human(() => solverCalls++);
  const { page, stats } = await fixture(
    t,
    '<h1>Pro plan</h1><p>Due today PHP 9990</p><button>Pay</button><iframe srcdoc="<input type=email>"></iframe>'
  );
  assert.equal(await verification.isCheckoutPaymentReady(page), false);
  const expired = await form.inspectCardReadiness(page, { deadline: Date.now() - 1 });
  assert.equal(expired.ready, false);
  assert.equal(expired.code, 'CHECKOUT_FORM_TIMEOUT');
  assert.equal(expired.inspection.timedOut, true);
  assert.equal(expired.inspection.complete, false);
  const result = await verification.clearHumanVerification(page, {
    requireCheckoutReady: true,
    checkoutReadyWaitMs: 1200,
    maxWaitMs: 4000,
    isSubmitted: () => false
  });
  assert.equal(result.cleared, false);
  assert.equal(result.checkoutNotReady, true);
  assert.equal(result.captchaRequired, false);
  // A late CDP scan may consume the short readiness deadline. It must report
  // an incomplete timeout, never imply that the unrelated frame proved ready.
  if (result.code === 'CHECKOUT_FORM_TIMEOUT') {
    assert.equal(result.diagnostics.inspection.timedOut, true);
    assert.equal(result.diagnostics.inspection.complete, false);
  } else {
    assert.equal(result.code, 'CHECKOUT_FORM_NOT_READY');
    assert.equal(result.diagnostics.inspection.complete, true);
  }
  assert.equal(solverCalls, 0);
  assert.equal(stats.documents, 1);
  assert.equal(stats.writes, 0);
});

test('hidden failure template does not block a usable number field or require later card fields upfront', async (t) => {
  const { page, stats } = await fixture(t, '<div hidden>' + failureHtml + '</div>' + readyHtml);
  const result = await human().clearHumanVerification(page, {
    requireCheckoutReady: true,
    maxWaitMs: 2000,
    isSubmitted: () => false
  });
  assert.equal(result.cleared, true);
  assert.equal(stats.documents, 1);
  assert.equal(stats.writes, 0);
});

test('explicit content failure is a loading error and never invokes an image solver', async (t) => {
  let calls = 0;
  const { page, stats } = await fixture(t, failureHtml + '<p>Due today PHP 9990</p>');
  const started = performance.now();
  const result = await human(() => calls++).clearHumanVerification(page, {
    requireCheckoutReady: true,
    maxWaitMs: 2000,
    isSubmitted: () => false
  });
  assert.equal(result.code, 'CHECKOUT_CONTENT_LOAD_FAILED');
  assert.equal(result.captchaRequired, false);
  assert.equal(result.checkoutNotReady, true);
  assert.equal(calls, 0);
  assert.ok(performance.now() - started < 1800);
  assert.equal(stats.documents, 1);
  assert.equal(stats.writes, 0);
});

test('one exact original reload restores readiness and leaves no checkout or payment writes', async (t) => {
  const { page, stats } = await fixture(t, (n) => (n === 1 ? failureHtml : readyHtml));
  const result = await human().clearHumanVerification(page, {
    requireCheckoutReady: true,
    allowCheckoutReload: true,
    maxWaitMs: 4000,
    checkoutReadyWaitMs: 3000,
    isSubmitted: () => false
  });
  assert.equal(result.cleared, true);
  assert.equal(stats.documents, 2);
  assert.equal(stats.writes, 0);
  assert.equal(page.url(), original);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(page).reloadAttempts, 1);
  assert.equal((await form.inspectCardReadiness(page)).ready, true);
  const checkedAgain = await human().clearHumanVerification(page, {
    requireCheckoutReady: true,
    allowCheckoutReload: true,
    maxWaitMs: 2000,
    isSubmitted: () => false
  });
  assert.equal(checkedAgain.cleared, true);
  assert.equal(stats.documents, 2);
});

test('a persistent failure stops after the single reload without being relabelled as captcha', async (t) => {
  const { page, stats } = await fixture(t, failureHtml);
  const result = await human().clearHumanVerification(page, {
    requireCheckoutReady: true,
    allowCheckoutReload: true,
    maxWaitMs: 4000,
    isSubmitted: () => false
  });
  assert.equal(result.cleared, false);
  assert.equal(result.checkoutNotReady, true);
  assert.equal(result.captchaRequired, false);
  assert.match(result.code, /^CHECKOUT_(?:CONTENT_LOAD_FAILED|RELOAD_)/);
  assert.equal(stats.documents, 2);
  assert.equal(stats.writes, 0);
  assert.equal(result.diagnostics.reloadAttempts, 1);
});

test('payment-started state refuses even the original checkout reload', async (t) => {
  const { page, stats } = await fixture(t, failureHtml);
  const result = await human().clearHumanVerification(page, {
    requireCheckoutReady: true,
    allowCheckoutReload: true,
    maxWaitMs: 3000,
    isSubmitted: () => true
  });
  assert.equal(result.cleared, false);
  assert.equal(result.checkoutNotReady, true);
  assert.match(result.code, /^CHECKOUT_RELOAD_/);
  assert.equal(stats.documents, 1);
  assert.equal(stats.writes, 0);
});

test('full payment entry reports loading failure before fill or submission and preserves its cause', async (t) => {
  const { page, stats } = await fixture(t, failureHtml);
  let submissions = 0;
  const result = await stripe(human(), () => submissions++).completeStripeCardPayment(
    page,
    { number: '4242424242424242', expiry: '10/31', cvc: '123', holder: 'Synthetic Fixture' },
    {},
    { holderName: 'Synthetic Fixture' }
  );
  assert.equal(result.success, false);
  assert.equal(result.submitted, false);
  assert.equal(result.canRetryCard, false);
  assert.match(result.errorCode, /^CHECKOUT_(?:CONTENT_LOAD_FAILED|RELOAD_)/);
  assert.equal(result.formDiagnostics.loading.reloadAttempts, 1);
  assert.equal(result.captchaRequired, undefined);
  assert.equal(submissions, 0);
  assert.equal(stats.documents, 2);
  assert.equal(stats.writes, 0);
});

test('a component failure between readiness and card fill recovers once inside the same fill deadline', async (t) => {
  const { page, stats } = await fixture(
    t,
    readyHtml + '<input autocomplete="cc-exp"><input autocomplete="cc-csc">'
  );
  const deadlines = [];
  let submissions = 0;
  const wrappedForm = {
    ...form,
    async fillCard(current, card, options) {
      deadlines.push(options.deadline);
      if (deadlines.length === 1) await current.setContent(failureHtml);
      return form.fillCard(current, card, options);
    }
  };
  const result = await stripe(human(), () => submissions++, wrappedForm).completeStripeCardPayment(
    page,
    { number: '4242424242424242', expiry: '10/31', cvc: '123', holder: 'Synthetic Fixture' },
    {},
    { holderName: 'Synthetic Fixture' }
  );
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'CHECKOUT_FORM_DATA_MISSING');
  assert.equal(result.submitted, false);
  assert.equal(deadlines.length, 2);
  assert.equal(deadlines[0], deadlines[1]);
  assert.equal(
    await page.locator('input[autocomplete="cc-number"]').inputValue(),
    '4242424242424242'
  );
  assert.equal(stats.documents, 2);
  assert.equal(stats.writes, 0);
  assert.equal(submissions, 0);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(page).reloadAttempts, 1);
});

test('hosted checkout can recover loading before Card selection and finish protection only after strict readiness', async (t) => {
  const hosted = 'https://checkout.stripe.com/c/pay/cs_test_loadingOriginal';
  const fields = readyHtml + '<input autocomplete="cc-exp"><input autocomplete="cc-csc">';
  const methodPage =
    '<button data-testid="card-tab" onclick=\'document.body.innerHTML=' +
    JSON.stringify(fields) +
    "'>Credit or debit card</button>";
  const { page, stats } = await fixture(t, (n) => (n === 1 ? failureHtml : methodPage), hosted);
  const opened = await human().clearHumanVerification(page, {
    checkCheckoutLoad: true,
    requireCheckoutReady: false,
    allowCheckoutReload: true,
    maxWaitMs: 8000,
    isSubmitted: () => false
  });
  assert.equal(opened.cleared, true);
  assert.equal(await human().isCheckoutPaymentReady(page), false);
  assert.equal(recovery.originalCheckoutReloadDiagnostics(page).code, 'CHECKOUT_RELOAD_READONLY');
  let submissions = 0;
  const result = await stripe(human(), () => submissions++).completeStripeCardPayment(
    page,
    { number: '4242424242424242', expiry: '10/31', cvc: '123', holder: 'Synthetic Fixture' },
    {},
    { holderName: 'Synthetic Fixture' }
  );
  assert.equal(result.errorCode, 'CHECKOUT_FORM_DATA_MISSING');
  assert.equal(result.submitted, false);
  assert.equal(
    await page.locator('input[autocomplete="cc-number"]').inputValue(),
    '4242424242424242'
  );
  assert.equal(recovery.originalCheckoutReloadDiagnostics(page).code, 'CHECKOUT_RELOAD_READY');
  assert.equal(stats.documents, 2);
  assert.equal(stats.writes, 0);
  assert.equal(submissions, 0);
});

test('content failure takes priority over a stale visible captcha at the payment entry', async (t) => {
  const checkbox = 'https://newassets.hcaptcha.com/captcha/v1/fixture/hcaptcha.html#frame=checkbox';
  let checkboxClicks = 0,
    solverCalls = 0,
    submissions = 0;
  const fields = readyHtml + '<input autocomplete="cc-exp"><input autocomplete="cc-csc">';
  const { page, stats } = await fixture(t, (n, req) => {
    if (new URL(req.url()).hostname === 'newassets.hcaptcha.com')
      return '<div role="checkbox" aria-checked="false" tabindex="0" style="width:150px;height:40px" onclick="globalThis.__recordCheckbox()">I am human</div>';
    return n === 1
      ? failureHtml + `<iframe src="${checkbox}" style="width:300px;height:100px"></iframe>`
      : fields;
  });
  await page.exposeFunction('__recordCheckbox', () => checkboxClicks++);
  const result = await stripe(
    human(() => solverCalls++),
    () => submissions++
  ).completeStripeCardPayment(
    page,
    { number: '4242424242424242', expiry: '10/31', cvc: '123', holder: 'Synthetic Fixture' },
    {},
    { holderName: 'Synthetic Fixture' }
  );
  assert.equal(result.errorCode, 'CHECKOUT_FORM_DATA_MISSING');
  assert.equal(result.submitted, false);
  assert.equal(checkboxClicks, 0);
  assert.equal(solverCalls, 0);
  assert.equal(submissions, 0);
  assert.equal(stats.documents, 2);
  assert.equal(stats.writes, 0);
});

test('a recovery halted after readiness cannot consume the payment submission or click the merchant button', async (t) => {
  const button =
    '<button onclick="window.syntheticClicks++">Subscribe</button><script>window.syntheticClicks=0</script>';
  const { page, stats } = await fixture(t, (n) => (n === 1 ? failureHtml : readyHtml + button));
  const options = { deadlineAt: performance.now() + 10000, isSubmitted: () => false };
  await recovery.reloadOriginalCheckout(page, options);
  await recovery.finishOriginalCheckoutReload(page, options);
  await assert.rejects(recovery.reloadOriginalCheckout(page, options), {
    code: 'CHECKOUT_RELOAD_ALREADY_ATTEMPTED'
  });
  let submissions = 0;
  await assert.rejects(
    stripe(human(), () => submissions++).clickCheckoutSubmitButton(page, {
      paymentContext: { kind: 'initial', amount: '9990', currency: 'PHP' }
    }),
    { code: 'CHECKOUT_RELOAD_ALREADY_ATTEMPTED' }
  );
  assert.equal(submissions, 0);
  assert.equal(await page.evaluate(() => window.syntheticClicks), 0);
  assert.equal(stats.writes, 0);
});
