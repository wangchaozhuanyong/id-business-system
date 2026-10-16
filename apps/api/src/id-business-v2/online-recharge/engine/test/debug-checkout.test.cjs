'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

// Evaluate the actual readonly helper without importing the payment executor.
const source = fs.readFileSync(path.join(__dirname, '../upstream/index.js'), 'utf8');
const start = source.indexOf('const DEBUG_PAYMENT_BUTTON_PATTERNS =');
const end = source.indexOf('\nfunction buildDebugScreenshotPath', start);
assert.ok(start >= 0 && end > start);

function fixture(labels) {
  let now = 0;
  const effects = { click: 0, fill: 0 };
  const click = async () => {
    effects.click++;
    throw new Error('Debug must not click');
  };
  const fill = async () => {
    effects.fill++;
    throw new Error('Debug must not fill');
  };
  const wait = runInNewContext(source.slice(start, end) + '\nwaitForDebugPaymentStep;', {
    Date: { now: () => now },
    console: { log() {} }
  });
  const page = {
    click,
    fill,
    getByRole(role, { name }) {
      assert.equal(role, 'button');
      return {
        count: async () => labels.filter((label) => name.test(label)).length,
        isVisible: async () => true,
        click,
        fill
      };
    },
    waitForTimeout: async (milliseconds) => {
      now += milliseconds;
    }
  };
  return { page, wait, effects, elapsed: () => now };
}

for (const label of ['Subscribe', '订阅', '立即支付', 'Pay now', 'Upgrade to Pro']) {
  test(`debug recognizes ${label} without clicking or filling`, async () => {
    const f = fixture([label]);
    await f.wait(f.page);
    assert.equal(f.elapsed(), 0);
    assert.deepEqual(f.effects, { click: 0, fill: 0 });
  });
}

test('debug keeps its 60 second timeout when no supported final button is present', async () => {
  const f = fixture(['Cancel', 'Upgrade to Plus']);
  await assert.rejects(f.wait(f.page), /未检测到订阅\/支付提交按钮/);
  assert.equal(f.elapsed(), 60000);
  assert.deepEqual(f.effects, { click: 0, fill: 0 });
});

test('only checkout debug permits an unverified target through the actual index preflight call', async () => {
  const preflightStart = source.indexOf(
    "const preflight = await require('../confirmation.cjs').preflightPayment"
  );
  const preflightEnd = source.indexOf('\n        // --- Phase 2:', preflightStart);
  assert.ok(preflightStart >= 0 && preflightEnd > preflightStart);
  for (const debugOnly of [false, true]) {
    const calls = [];
    const check = runInNewContext(
      '(async () => {' + source.slice(preflightStart, preflightEnd) + '\nreturn preflight; })',
      {
        planType: 'pro_500',
        accessToken: 'synthetic-token',
        billingCurrency: 'PHP',
        debugOnly,
        require: (moduleName) => {
          assert.equal(moduleName, '../confirmation.cjs');
          return {
            resolvePaymentCurrency: require('../confirmation.cjs').resolvePaymentCurrency,
            preflightPayment: async (target, token, options) => {
              calls.push({ target, token, allowUnverifiedTarget: options.allowUnverifiedTarget });
              return {
                allowed: debugOnly,
                kind: 'upgrade',
                error: debugOnly ? undefined : '未核实目标标识'
              };
            }
          };
        }
      }
    );
    const result = await check();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, 'pro_500');
    assert.equal(calls[0].allowUnverifiedTarget, debugOnly);
    assert.equal(result.allowed, debugOnly);
    if (!debugOnly) assert.equal(result.submitted, false);
  }
});

for (const currency of ['JPY', null]) {
  test(`debug preserves unverified PH and observed ${currency} before any card or payment execution`, async () => {
    const branchStart = source.indexOf(
      '        if (debugOnly) {\n            await waitForDebugPaymentStep(page);'
    );
    const branchEnd = source.indexOf(
      "        console.log('✅ [步骤] Checkout 页面已打开，开始信用卡支付流程...');",
      branchStart
    );
    assert.ok(branchStart >= 0 && branchEnd > branchStart);
    let cardOrPaymentCalls = 0;
    const forbidden = async () => {
      cardOrPaymentCalls++;
      throw new Error('Debug must stop before payment');
    };
    const run = runInNewContext(
      '(async () => {' +
        source.slice(branchStart, branchEnd) +
        '\nawait executePaymentWithRetry(); })',
      {
        debugOnly: true,
        operation: 'initial',
        billingCountry: 'PH',
        page: {},
        checkoutResult: {
          checkoutUrl: 'https://chatgpt.com/checkout/synthetic',
          pricingRegionVerified: false
        },
        console: { log() {}, warn() {} },
        waitForDebugPaymentStep: async () => {},
        executePaymentWithRetry: forbidden,
        require: (name) => {
          assert.equal(name, './stripe-payment');
          return {
            readCheckoutDueAmount: async () => (currency ? { amount: '0', currency } : null),
            reserveCard: forbidden,
            beforeExternalSubmit: forbidden
          };
        }
      }
    );
    const result = await run();
    assert.equal(result.debugOnly, true);
    assert.equal(result.requestedRegion, 'PH');
    assert.equal(result.observedCurrency, currency);
    assert.equal(result.pricingRegionVerified, false);
    assert.equal(cardOrPaymentCalls, 0);
  });
}
