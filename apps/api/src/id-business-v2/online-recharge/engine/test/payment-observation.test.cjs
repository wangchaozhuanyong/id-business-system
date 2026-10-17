'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { runInNewContext } = require('node:vm');
const { chromium } = require('../upstream/node_modules/playwright');
const verificationRuntime = require('../upstream/verification-runtime');
const captchaPlatform = require('../upstream/captcha-platform');
const checkout = require('../checkout-recovery.cjs');
const taskControl = require('../rpc.cjs');
const source = fs.readFileSync(path.join(__dirname, '../upstream/stripe-payment.js'), 'utf8');
const humanSource = fs.readFileSync(
  path.join(__dirname, '../upstream/human-verification.js'),
  'utf8'
);

function load({
  clock = performance,
  verification = {},
  rpc = {},
  env = {},
  screenshot = async () => null
} = {}) {
  const module = { exports: {} };
  runInNewContext(
    source + '\nmodule.exports.clickCheckoutSubmitButton = clickCheckoutSubmitButton;',
    {
      module,
      URL,
      console: { log() {}, warn() {}, error() {} },
      process: { env },
      require(name) {
        if (name === 'node:perf_hooks') return { performance: clock };
        if (name === '../rpc.cjs')
          return { taskSignal: () => undefined, wasSubmitted: () => false, ...rpc };
        if (name === '../safe-media.cjs') return { screenshot };
        if (name === './human-verification')
          return {
            isHumanVerificationVisible: async () => false,
            hasAnyCheckoutCaptchaSignal: async () => false,
            ...verification
          };
        if (
          name.startsWith('.') &&
          name !== '../checkout-recovery.cjs' &&
          name !== '../outcomes.cjs'
        ) {
          throw new Error('Unexpected synthetic import ' + name);
        }
        return name.startsWith('.')
          ? require(path.join(__dirname, '../upstream', name))
          : require(name);
      }
    }
  );
  return module.exports;
}
function page() {
  const empty = {
    count: async () => 0,
    first() {
      return this;
    },
    nth() {
      return this;
    },
    filter() {
      return this;
    },
    locator() {
      return this;
    },
    getByRole() {
      return this;
    },
    isVisible: async () => false
  };
  return {
    url: () => 'https://chatgpt.com/checkout/openai_llc/oaics_fixtureOriginal',
    textContent: async () => '',
    getByRole: () => empty,
    getByText: () => empty,
    locator: () => empty,
    keyboard: { press: async () => {} },
    evaluate: async () => {},
    frames: () => [],
    setDefaultTimeout() {},
    waitForTimeout: async () => {}
  };
}

test('overlay wait, verification and result polling share one absolute post-submit deadline', async () => {
  let now = 0;
  const calls = [];
  const stripe = load({
    clock: { now: () => now },
    verification: {
      hasAnyCheckoutCaptchaSignal: async () => true,
      clearHumanVerification: async (_, options) => {
        calls.push(options);
        now = calls.length === 1 ? 170000 : 179000;
        return calls.length === 1
          ? { cleared: true }
          : {
              cleared: false,
              code: 'VERIFICATION_UNSUPPORTED',
              diagnostics: {
                state: 'unsupported',
                providerCode: 'TYPE_UNSUPPORTED',
                session: 'must-not-leak'
              }
            };
      }
    }
  });
  const currentPage = page();
  const post = await stripe.handlePostSubmitPhase(currentPage);
  assert.equal(post.deadlineAt, 180000);
  const result = await stripe.waitForPaymentResult(currentPage, 'Synthetic', {
    deadlineAt: post.deadlineAt
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].deadlineAt, 180000);
  assert.equal(calls[1].deadlineAt, 180000);
  assert.equal(calls[1].maxWaitMs, 10000);
  assert.equal(result.resultUnknown, true);
  assert.equal(result.errorCode, 'VERIFICATION_UNSUPPORTED');
  assert.equal(result.verificationDiagnostics.providerCode, 'TYPE_UNSUPPORTED');
  assert.equal(Object.hasOwn(result.verificationDiagnostics, 'session'), false);
});

test('expired result budget and lease cancellation do not start another verification round', async () => {
  let calls = 0;
  const stripe = load({
    verification: {
      clearHumanVerification: async () => {
        calls++;
      }
    }
  });
  const expired = await stripe.waitForPaymentResult(page(), 'Synthetic', {
    deadlineAt: performance.now() - 1
  });
  assert.equal(expired.resultUnknown, true);
  assert.equal(expired.errorCode, 'PAYMENT_RESULT_TIMEOUT');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    stripe.waitForPaymentResult(page(), 'Synthetic', { signal: controller.signal }),
    { code: 'LEASE_LOST' }
  );
  assert.equal(calls, 0);
});

test('a stalled read is bounded by the inherited deadline and cannot become payment proof', async () => {
  const stripe = load({
    verification: { hasAnyCheckoutCaptchaSignal: async () => new Promise(() => {}) }
  });
  const start = performance.now();
  const result = await stripe.waitForPaymentResult(page(), 'Synthetic', { deadlineAt: start + 30 });
  assert.equal(result.success, false);
  assert.equal(result.resultUnknown, true);
  assert.equal(result.errorCode, 'PAYMENT_RESULT_TIMEOUT');
  assert.ok(performance.now() - start < 1000);
});

test('the only submit intent persists the exact original recovery before the one click', async () => {
  const calls = [];
  let submitted = false;
  const stripe = load({
    rpc: {
      wasSubmitted: () => submitted,
      beforeExternalSubmit: async (value) => {
        calls.push(['intent', value]);
        submitted = true;
      }
    }
  });
  const currentPage = page();
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    isDisabled: async () => false,
    scrollIntoViewIfNeeded: async () => {},
    click: async () => calls.push(['click'])
  };
  currentPage.getByRole = () => button;
  const paymentContext = { quoteId: 'fixed-original-quote', currency: 'PHP', amount: '8919.64' };
  const checkoutRecovery = {
    version: 1,
    quoteId: paymentContext.quoteId,
    checkoutId: 'oaics_fixtureOriginal'
  };
  assert.equal(
    await stripe.clickCheckoutSubmitButton(currentPage, {
      paymentContext,
      checkoutRecovery,
      paymentObservation: { arm: () => calls.push(['arm']) }
    }),
    true
  );
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['intent', 'arm', 'click']
  );
  assert.equal(calls[0][1].checkoutRecovery, checkoutRecovery);
  assert.equal(calls[0][1].paymentContext, paymentContext);
});

test('cancelled card payment exits without another diagnostic screenshot', async () => {
  const controller = new AbortController();
  const cancelled = Object.assign(new Error('任务已停止'), { code: 'TASK_ABORTED' });
  let screenshots = 0;
  const stripe = load({
    rpc: { taskSignal: () => controller.signal },
    screenshot: async () => {
      screenshots++;
    },
    verification: {
      clearHumanVerification: async () => {
        controller.abort(cancelled);
        throw cancelled;
      }
    }
  });
  await assert.rejects(
    stripe.completeStripeCardPayment(page(), {}, null),
    (error) => error === cancelled
  );
  assert.equal(screenshots, 0);
});

test('pre-submit failures preserve controlled recovery codes and their accurate Chinese reason', async () => {
  const reason = '当前结账页的原单格式尚未核实支持，本次未提交付款';
  for (const code of ['CHECKOUT_RECOVERY_UNSUPPORTED', 'not a controlled error code']) {
    const stripe = load({
      verification: {
        clearHumanVerification: async () => {
          throw Object.assign(new Error(reason), { code });
        }
      }
    });
    const result = await stripe.completeStripeCardPayment(page(), {}, null);
    assert.equal(result.success, false);
    assert.equal(result.error, reason);
    assert.equal(result.errorCode, code === 'CHECKOUT_RECOVERY_UNSUPPORTED' ? code : undefined);
  }
});

function actualHumanVerification(solve) {
  const module = { exports: {} };
  runInNewContext(humanSource, {
    module,
    URL,
    Date,
    Math,
    console: { log() {} },
    process: { env: { HEADFUL: '0' } },
    require(name) {
      if (name === './hcaptcha-solver')
        return { solveHcaptchaOnPage: solve, isHcaptchaSolverEnabled: () => true };
      if (name === './captcha-platform')
        return { ...captchaPlatform, isCaptchaPlatformEnabled: () => false };
      if (name === './verification-runtime') return verificationRuntime;
      if (name === './auth-page-detect') return require('../upstream/auth-page-detect');
      throw new Error('Unexpected synthetic import ' + name);
    }
  });
  return module.exports;
}

let paymentBrowser;
test.after(async () => paymentBrowser?.close());
for (const scenario of ['success', 'failure', 'changed-challenge-retry']) {
  test(
    `real Chromium payment submission stays once through captcha ${scenario}`,
    { timeout: 20000 },
    async (t) => {
      paymentBrowser ||= await chromium.launch({
        headless: true,
        args: [
          '--disable-background-networking',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
        ]
      });
      const context = await paymentBrowser.newContext({ serviceWorkers: 'block' });
      const counts = {
        paymentSubmissions: 0,
        newCheckouts: 0,
        intents: 0,
        solverCalls: 0,
        successfulCaptchaChecks: 0,
        intentReads: 0
      };
      const unexpected = [];
      const checkoutId = 'oaics_syntheticSinglePayment';
      const accountId = '11111111-1111-4111-8111-111111111111';
      const cardId = '22222222-2222-4222-8222-222222222222';
      const token =
        'synthetic.' +
        Buffer.from(
          JSON.stringify({
            'https://api.openai.com/auth': { chatgpt_account_id: accountId }
          })
        ).toString('base64url') +
        '.not-a-credential';
      const url = `https://chatgpt.com/checkout/openai_llc/${checkoutId}`;
      const intentId = 'pi_syntheticSinglePayment';
      const challengeUrl =
        'https://newassets.hcaptcha.com/captcha/v1/synthetic/static/hcaptcha.html?kind=challenge#frame=challenge';
      const cors = {
        'access-control-allow-origin': 'https://chatgpt.com',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization'
      };
      const json = (route, data) =>
        route.fulfill({
          contentType: 'application/json',
          headers: cors,
          body: JSON.stringify(data)
        });
      await context.route('**/*', async (route) => {
        const request = route.request(),
          target = new URL(request.url());
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (
          target.origin === 'https://chatgpt.com' &&
          target.pathname === '/backend-api/payments/checkout' &&
          request.method() === 'POST'
        ) {
          counts.newCheckouts++;
          return json(route, {
            error: 'Creating another checkout is forbidden in this original-checkout test'
          });
        }
        if (
          target.origin === 'https://chatgpt.com' &&
          target.pathname === '/backend-api/payments/checkout/confirm' &&
          request.method() === 'POST'
        ) {
          counts.paymentSubmissions++;
          assert.equal(request.postDataJSON().checkout_session_id, checkoutId);
          return json(route, {
            type: 'payment_intent',
            client_secret: `${intentId}_secret_syntheticOnly`
          });
        }
        if (
          target.origin === 'https://api.stripe.com' &&
          target.pathname === `/v1/payment_intents/${intentId}` &&
          request.method() === 'GET'
        ) {
          counts.intentReads++;
          return json(route, {
            object: 'payment_intent',
            id: intentId,
            status: 'succeeded',
            amount_received: 891964,
            currency: 'php'
          });
        }
        if (
          target.origin === 'https://api.hcaptcha.com' &&
          target.pathname.startsWith('/getcaptcha/')
        ) {
          return json(route, {
            key: target.pathname.endsWith('second') ? 'synthetic-second' : 'synthetic-first',
            request_type: 'image_label_binary',
            requester_question: { en: 'Please select all squares' },
            tasklist: [{}]
          });
        }
        if (
          target.origin === 'https://api.hcaptcha.com' &&
          target.pathname === '/checkcaptcha/synthetic'
        ) {
          counts.successfulCaptchaChecks++;
          return json(route, { pass: true });
        }
        if (target.origin === 'https://newassets.hcaptcha.com')
          return route.fulfill({
            contentType: 'text/html',
            body: '<h2 id="prompt-question">Please select all squares</h2><canvas width="180" height="180"></canvas>'
          });
        if (request.url() === url && request.method() === 'GET')
          return route.fulfill({
            contentType: 'text/html',
            body: '<div id="result">Due today PHP 8919.64</div><button id="pay">Subscribe</button><div id="captcha"></div>'
          });
        unexpected.push({ method: request.method(), host: target.hostname, path: target.pathname });
        return route.abort('blockedbyclient');
      });
      taskControl.configureTask({ id: 'synthetic-payment-' + scenario });
      taskControl.setTransportForTest(async (method) => {
        assert.equal(method, 'beforeExternalSubmit');
        counts.intents++;
        return { ok: true };
      });
      let observation, currentPage;
      try {
        currentPage = await context.newPage();
        await verificationRuntime.prepareVerificationPage(currentPage, {
          signal: taskControl.taskSignal()
        });
        await currentPage.goto(url);
        await currentPage.evaluate(
          ({ token, accountId, checkoutId, challengeUrl }) => {
            globalThis.document.getElementById('pay').onclick = async () => {
              await fetch('/backend-api/payments/checkout/confirm', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: 'Bearer ' + token,
                  'chatgpt-account-id': accountId
                },
                body: JSON.stringify({ checkout_session_id: checkoutId })
              }).then((response) => response.json());
              await fetch('https://api.hcaptcha.com/getcaptcha/first').then((response) =>
                response.json()
              );
              globalThis.document.getElementById('captcha').innerHTML =
                '<div id="overlay">One more step before you are done. Select the checkbox below.</div><iframe src="' +
                challengeUrl +
                '" style="width:300px;height:300px"></iframe>';
            };
          },
          { token, accountId, checkoutId, challengeUrl }
        );
        const paymentContext = {
          kind: 'initial',
          sourcePlan: 'free',
          targetPlan: 'pro_20x',
          accountId,
          cardId,
          cardLast4: '4242',
          currency: 'PHP',
          amount: '8919.64',
          quoteId: checkout.quoteIdForUrl(url)
        };
        const recovery = checkout.buildCheckoutRecovery(url, paymentContext);
        observation = checkout.observePayment(currentPage, recovery, {
          signal: taskControl.taskSignal()
        });
        const seenChallenges = [];
        const human = actualHumanVerification(async ({ challenge }) => {
          counts.solverCalls++;
          seenChallenges.push(challenge?.key);
          if (scenario === 'failure')
            return { ok: false, code: 'VLM_AUTH_FAILED', retryable: false };
          if (scenario === 'changed-challenge-retry' && counts.solverCalls === 1) {
            await currentPage.evaluate(async () =>
              fetch('https://api.hcaptcha.com/getcaptcha/second').then((r) => r.json())
            );
            return { ok: false, code: 'VLM_INVALID_RESPONSE', retryable: true };
          }
          await currentPage.evaluate(async (intentUrl) => {
            await fetch('https://api.hcaptcha.com/checkcaptcha/synthetic', { method: 'POST' }).then(
              (r) => r.json()
            );
            await fetch(intentUrl).then((r) => r.json());
            globalThis.document.querySelector('iframe').hidden = true;
            globalThis.document.getElementById('overlay').remove();
            globalThis.document.getElementById('result').textContent = 'Thank you for subscribing';
          }, `https://api.stripe.com/v1/payment_intents/${intentId}`);
          return { ok: true };
        });
        const stripe = load({
          verification: human,
          rpc: taskControl,
          env: {
            CAPTCHA_OVERLAY_WAIT_MS: '3000',
            POST_SUBMIT_POLL_MS: '50',
            CAPTCHA_POST_SUBMIT_TIMEOUT_MS: '9000',
            PAYMENT_RESULT_TIMEOUT_MS: '9000',
            CAPTCHA_POST_SUBMIT_MAX_ROUNDS: '3'
          }
        });
        const result = await stripe.finalizeCheckoutPayment(currentPage, 'Synthetic Account', {
          paymentContext,
          checkoutRecovery: recovery,
          paymentObservation: observation,
          signal: taskControl.taskSignal()
        });
        const evidence = await observation.flush();
        t.diagnostic(
          JSON.stringify({
            scenario,
            ...counts,
            resultCode: result.errorCode || null,
            success: result.success,
            receiptVerified: evidence?.verified === true
          })
        );
        assert.equal(
          counts.paymentSubmissions,
          1,
          'Count the browser POST actually received by the intercepted payment service'
        );
        assert.equal(
          counts.newCheckouts,
          0,
          'The existing original checkout must never be replaced by another order'
        );
        assert.equal(counts.intents, 1);
        assert.deepEqual(unexpected, []);
        assert.equal(counts.solverCalls, scenario === 'changed-challenge-retry' ? 2 : 1);
        if (scenario === 'failure') {
          assert.equal(result.success, false);
          assert.equal(result.resultUnknown, true);
          assert.equal(result.errorCode, 'VLM_AUTH_FAILED');
          assert.equal(evidence, null);
          assert.equal(counts.successfulCaptchaChecks, 0);
          assert.equal(counts.intentReads, 0);
        } else {
          assert.equal(result.success, true);
          assert.equal(evidence?.verified, true);
          assert.equal(counts.successfulCaptchaChecks, 1);
          assert.equal(counts.intentReads, 1);
        }
        if (scenario === 'changed-challenge-retry') {
          assert.equal(seenChallenges.every(Boolean), true);
          assert.notEqual(seenChallenges[0], seenChallenges[1]);
        }
      } finally {
        await observation?.dispose();
        if (currentPage) verificationRuntime.disposeVerificationPage(currentPage);
        await context.close();
        taskControl.setTransportForTest(null);
        taskControl.clearTask();
        require('../security.cjs').clearSecrets();
      }
    }
  );
}
