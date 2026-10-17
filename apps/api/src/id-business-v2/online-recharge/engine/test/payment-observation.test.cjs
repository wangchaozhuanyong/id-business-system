'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { runInNewContext } = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../upstream/stripe-payment.js'), 'utf8');

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
