'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const { chromium } = require('../upstream/node_modules/playwright');
const { openPricingCheckout } = require('../upstream/pricing-checkout');

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

test('accepted failed debug retains only its original link through the existing protected result channel', async () => {
  const failureStart = source.indexOf('        const resultUnknown =');
  const failureEnd = source.indexOf('\n    } finally {', failureStart);
  assert.ok(failureStart >= 0 && failureEnd > failureStart);
  const original = 'https://chatgpt.com/checkout/openai_fixture/cs_test_failedDebugOriginal';
  for (const scenario of [
    { debugOnly: true, submitted: false, accepted: true, retain: true },
    { debugOnly: false, submitted: false, accepted: true, retain: false },
    { debugOnly: true, submitted: true, accepted: true, retain: false },
    { debugOnly: true, submitted: false, accepted: false, retain: false },
    { debugOnly: true, submitted: false, accepted: true, retain: true, terminalPage: true }
  ]) {
    const error = Object.assign(new Error('Payment UI did not initialize'), {
      code: 'CHECKOUT_OPEN_FAILED',
      checkoutCreationState: scenario.accepted ? 'accepted' : 'unknown',
      checkoutOpenDiagnostics: {
        stage: 'readiness',
        reason: scenario.terminalPage ? 'error_page' : 'not_ready',
        initialization: {
          version: 1,
          elapsedMs: 65886,
          eventCount: 875,
          readFailures: 0,
          truncated: true,
          events: [],
          firstFailure: {
            event: 'request_failed',
            elapsedMs: 5051,
            endpoint: 'other',
            frame: 'embedded',
            code: 'ABORTED'
          },
          failureClasses: [
            {
              event: 'csp',
              elapsedMs: 37154,
              endpoint: 'other',
              frame: 'unknown',
              code: 'BLOCKED_BY_CSP',
              directive: 'script-src',
              count: 1,
              lastElapsedMs: 37154
            },
            {
              event: 'request_failed',
              elapsedMs: 44013,
              endpoint: 'other',
              frame: 'embedded',
              code: 'CONNECTION_CLOSED',
              count: 1,
              lastElapsedMs: 44013
            }
          ],
          failureClassesTruncated: false
        }
      }
    });
    Object.defineProperty(error, 'originalCheckoutUrl', { value: original });
    const run = runInNewContext(
      '(async () => {' + source.slice(failureStart, failureEnd) + '\n})',
      {
        e: error,
        debugOnly: scenario.debugOnly,
        validation: null,
        lastPaymentResult: null,
        checkoutEvidence: {},
        paymentSucceeded: false,
        wasSubmitted: () => scenario.submitted,
        require: (name) => {
          if (name === '../rpc.cjs') return { wasPaymentConfirmed: () => false };
          if (name === '../checkout-creation-diagnostics.cjs')
            return require('../checkout-creation-diagnostics.cjs');
          if (name === './chatgpt') return require('../upstream/chatgpt');
          if (name === '../checkout-await-diagnostics.cjs')
            return require('../checkout-await-diagnostics.cjs');
          throw new Error('Unexpected failure-path dependency');
        }
      }
    );
    const result = await run();
    assert.match(result.error, /875条/);
    assert.match(result.error, /旧记录未采集请求下载完成及待完成清单/);
    assert.match(
      result.error,
      /后续观测异常（不等同根因）.*37154毫秒.*内容安全策略阻止.*44013毫秒.*连接关闭/
    );
    assert.equal(result.success, false);
    if (scenario.terminalPage) assert.match(result.error, /官网结账错误页（原因尚未确定）/);
    assert.equal(result.resultUnknown, scenario.submitted);
    assert.equal(result.checkoutUrl, scenario.retain ? original : undefined);
    assert.equal(result.error.includes(original), false);
    const security = require('../security.cjs');
    const transported = security.sanitizeResult(result);
    assert.equal(transported.checkoutUrl, scenario.retain ? original : undefined);
    assert.equal(JSON.stringify(security.sanitize(result)).includes(original), false);
  }
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
        validation: null,
        verificationHandler: async () => ({ completed: true }),
        checkoutEvidence: {},
        context: {},
        page: {},
        sessionRaw: 'synthetic-session',
        authDiagnostics: { snapshot: () => ({}) },
        taskSignal: () => new AbortController().signal,
        require: (moduleName) => {
          if (moduleName === '../human-verification.cjs')
            return { waitForHumanVerification: async () => ({ completed: true }) };
          assert.equal(moduleName, '../confirmation.cjs');
          return {
            resolvePaymentCurrency: require('../confirmation.cjs').resolvePaymentCurrency,
            preflightPayment: async (target, token, options) => {
              assert.equal(options.sessionRaw, 'synthetic-session');
              assert.equal(typeof options.authDiagnostics.snapshot, 'function');
              assert.equal(typeof options.onHumanVerification, 'function');
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
        checkoutEvidence: { checkoutInitialization: { version: 2 } },
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
    assert.equal(result.checkoutInitialization.version, 2);
    assert.equal(cardOrPaymentCalls, 0);
  });
}

test('actual UI checkout preserves legacy Pro selection and deferred exact tiers without payment', async (t) => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
  t.after(() => browser.close());
  for (const scenario of [
    { name: 'legacy exact 20x without top-half', legacy: true },
    { name: 'deferred exact Pro 200' },
    { name: 'deferred wrong checkout tier', wrong: true },
    { name: 'deferred ambiguous checkout tier', ambiguous: true }
  ]) {
    await t.test(scenario.name, async () => {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      const stats = { pricing: 0, checkout: 0, writes: 0, unexpected: 0 };
      const checkoutUrl = 'https://chatgpt.com/checkout/openai_fixture/cs_test_proUiContract';
      const target = '<input type="radio" aria-label="200" value="chatgptpro">';
      const options = scenario.wrong
        ? '<button id="chatgptpro" role="radio" value="chatgptprolite">100</button>'
        : target + (scenario.ambiguous ? target : '');
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          stats.writes++;
          return route.abort('blockedbyclient');
        }
        if (request.url() === 'https://chatgpt.com/') {
          stats.pricing++;
          const controls = scenario.legacy
            ? '<div role="group" aria-label="Pro plan"><button role="radio" aria-label="20x" aria-checked="false" onclick="this.setAttribute(\'aria-checked\',\'true\')">20x</button></div>'
            : '<section data-testid="pro-pricing-modal-column-top-half"><h2>Pro</h2></section>';
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><meta charset="utf-8"><main>
            <h2>ChatGPT Plus</h2><p>Philippines ₱ 9990</p>${controls}
            <button data-testid="select-plan-button-pro-upgrade" onclick="location.href='${checkoutUrl}'">Upgrade to Pro</button>
            </main>`
          });
        }
        if (request.url() === checkoutUrl) {
          stats.checkout++;
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><meta charset="utf-8"><main>
            <div role="radiogroup" aria-label="Pro usage">${options}</div>
            <button onclick="fetch('/fixture-submit-payment',{method:'POST'})">Subscribe</button>
            </main>`
          });
        }
        stats.unexpected++;
        return route.abort('blockedbyclient');
      });
      if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
      try {
        const opening = openPricingCheckout(page, {
          region: 'PH',
          planType: 'pro_20x',
          operation: 'initial',
          debugOnly: false
        });
        if (scenario.wrong || scenario.ambiguous)
          await assert.rejects(opening, scenario.wrong ? /档位标识不匹配/ : /数字档位不唯一/);
        else {
          const result = await opening;
          assert.equal(result.kind, 'checkout');
          assert.equal(result.pricingRegionVerified, true);
          assert.equal(
            await page.getByRole('radio', { name: '200', exact: true }).isChecked(),
            true
          );
        }
        assert.equal(stats.pricing, 1);
        assert.equal(stats.checkout, 1, 'deferred selection must reach the actual Checkout gate');
        assert.equal(stats.writes, 0, 'UI opening and tier confirmation must never pay');
        assert.equal(stats.unexpected, 0);
      } finally {
        await context.close();
      }
    });
  }
});
