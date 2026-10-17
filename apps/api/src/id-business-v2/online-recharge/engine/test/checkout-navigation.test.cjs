'use strict';
/* global document, window */
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { chromium } = require('../upstream/node_modules/playwright');
const human = require('../upstream/human-verification');
const runtime = require('../upstream/verification-runtime');
const recovery = require('../checkout-recovery.cjs');
const rpc = require('../rpc.cjs');
const { openApiCheckout, safeCheckoutOpenDiagnostics } = require('../upstream/chatgpt');

const origin = 'https://chatgpt.com';
const checkoutId = 'cs_test_navigationOriginal';
const processorEntity = 'openai_fixture';
const originalUrl = `${origin}/checkout/${processorEntity}/${checkoutId}`;
const number = '<label>Card number<input autocomplete="cc-number"></label>';
const verificationStats = new WeakMap();
const clear = human.clearHumanVerification;
let browser;

test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--site-per-process',
      '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'
    ]
  });
  human.clearHumanVerification = async (page, options) => {
    const stats = verificationStats.get(page);
    if (stats) {
      stats.verifications++;
      stats.verificationBudget = { maxWaitMs: options.maxWaitMs, deadlineAt: options.deadlineAt };
    }
    return clear(page, options);
  };
});
test.after(async () => {
  human.clearHumanVerification = clear;
  await browser?.close();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function html({ fields = number, delayMs = 0, pendingModule = false, login = false } = {}) {
  return `<!doctype html><html><head><title>Synthetic original checkout</title>
    ${pendingModule ? '<script type="module" src="/fixture-pending-module.js"></script>' : ''}
    </head><body><h1>Configure your plan</h1><p>Due today PHP 9990.00</p>
    ${login ? '<button>Log in</button>' : ''}
    <section id="payment-method">${delayMs ? '' : fields}</section>
    <button id="subscribe" onclick="fetch('/fixture-payment-confirm',{method:'POST'})">Subscribe</button>
    ${delayMs ? `<script>setTimeout(()=>{document.getElementById('payment-method').innerHTML=${JSON.stringify(fields)};},${delayMs});</script>` : ''}
    </body></html>`;
}

async function fixture(t, options = {}) {
  const previous = {
    maxWait: process.env.CAPTCHA_CLEAR_TIMEOUT_MS,
    readyWait: process.env.CHECKOUT_READY_WAIT_MS
  };
  process.env.CAPTCHA_CLEAR_TIMEOUT_MS = String(options.maxWaitMs || 4500);
  process.env.CHECKOUT_READY_WAIT_MS = String(options.readyWaitMs || 3500);
  const module = deferred();
  const navigation = deferred();
  const stats = {
    creations: 0,
    documents: 0,
    payments: 0,
    otherWrites: 0,
    lateScripts: 0,
    lateWrites: 0,
    unrelatedWrites: 0,
    unexpected: 0,
    domContentLoaded: 0,
    verifications: 0,
    goto: []
  };
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.exposeFunction('recordLateCheckoutScript', () => {
    stats.lateScripts++;
  });
  // Playwright routes only the first URL of an HTTP redirect chain. Fulfil the
  // redirected native request at the public CDP boundary as well; DNS remains
  // disabled, so no redirect can reach the network.
  if (options.redirect) {
    const redirects = await context.newCDPSession(page);
    redirects.on('Fetch.requestPaused', async ({ requestId }) => {
      stats.documents++;
      await redirects.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/html' }],
        body: Buffer.from(html()).toString('base64')
      });
    });
    await redirects.send('Fetch.enable', { patterns: [{ urlPattern: options.redirect }] });
  }
  let closed = false;
  rpc.configureTask({
    id: 'synthetic-navigation',
    workerId: 'fixture-worker',
    leaseId: 'fixture-lease',
    leaseVersion: 1
  });
  t.after(async () => {
    runtime.disposeVerificationPage(page);
    await context.close();
    closed = true;
    module.resolve();
    navigation.resolve();
    rpc.clearTask();
    for (const [key, value] of Object.entries({
      CAPTCHA_CLEAR_TIMEOUT_MS: previous.maxWait,
      CHECKOUT_READY_WAIT_MS: previous.readyWait
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === 'POST' &&
      url.origin === origin &&
      url.pathname === '/backend-api/payments/checkout'
    ) {
      stats.creations++;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          checkout_session_id: checkoutId,
          processor_entity: processorEntity,
          url: originalUrl
        })
      });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      if (url.pathname === '/fixture-unrelated-write') {
        stats.unrelatedWrites++;
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      }
      if (url.pathname === '/fixture-late-write') stats.lateWrites++;
      if (url.pathname === '/fixture-payment-confirm') stats.payments++;
      else stats.otherWrites++;
      return route.abort('blockedbyclient');
    }
    if (request.url() === originalUrl) {
      stats.documents++;
      navigation.resolve();
      if (options.beforeDocument) await options.beforeDocument();
      if (closed || page.isClosed()) return;
      if (options.abortNavigation) return route.abort('connectionfailed');
      if (options.redirect)
        return route.fulfill({ status: 302, headers: { location: options.redirect } });
      return route.fulfill({
        status: options.status || 200,
        contentType: 'text/html',
        body: options.body || html(options)
      });
    }
    if (url.pathname === '/fixture-pending-module.js' && url.origin === origin) {
      await module.promise;
      return route
        .fulfill({ contentType: 'application/javascript', body: 'export {};' })
        .catch(() => {});
    }
    if (options.redirect && request.url() === options.redirect) {
      stats.documents++;
      return route.fulfill({ contentType: 'text/html', body: html() });
    }
    if (url.origin === origin && url.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: '<button>New chat</button>' });
    stats.unexpected++;
    return route.abort('blockedbyclient');
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  await page.goto(origin + '/');
  page.on('domcontentloaded', () => {
    if (page.url() === originalUrl) stats.domContentLoaded++;
  });
  const goto = page.goto.bind(page);
  page.goto = (url, configuration) => {
    stats.goto.push({ waitUntil: configuration.waitUntil, timeout: configuration.timeout });
    return goto(url, configuration);
  };
  // Only the transport boundary is adapted: the production service constructs
  // and parses its exact API payload, while native fetch reaches the local route.
  context.request.post = async (url, configuration) => {
    const response = await page.evaluate(
      async ({ url, configuration }) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: configuration.headers,
          body: JSON.stringify(configuration.data)
        });
        return { status: response.status, text: await response.text() };
      },
      { url, configuration }
    );
    return { status: () => response.status, text: async () => response.text };
  };
  verificationStats.set(page, stats);
  const start = () =>
    openApiCheckout(page, {
      accessToken: 'synthetic-noncredential',
      planType: 'pro_20x',
      country: 'PH',
      currency: 'PHP'
    });
  return { page, context, stats, start, navigation };
}

function stoppedWithoutPayment(stats) {
  assert.equal(stats.creations, 1, 'the accepted checkout must never be recreated');
  assert.equal(stats.payments, 0, 'opening/readiness must never submit payment');
  assert.equal(stats.otherWrites, 0);
  assert.equal(stats.unexpected, 0);
}

test('native commit reaches actual ready card controls while DOMContentLoaded stays pending', async (t) => {
  const { page, stats, start } = await fixture(t, { pendingModule: true });
  const result = await start();
  assert.equal(result.checkoutUrl, originalUrl);
  assert.equal(result.sessionId, checkoutId);
  assert.equal(stats.goto[0].waitUntil, 'commit');
  assert.equal(stats.domContentLoaded, 0);
  assert.equal(stats.verifications, 1);
  assert.equal(await human.isCheckoutPaymentReady(page), true);
  assert.equal(recovery.officialCheckoutForPage(page).checkoutId, checkoutId);
  stoppedWithoutPayment(stats);
});

test('commit and visible plan cannot finish opening until delayed actual card controls appear', async (t) => {
  const { page, stats, start } = await fixture(t, { pendingModule: true, delayMs: 1100 });
  let settled = false;
  const opening = start().then((value) => {
    settled = true;
    return value;
  });
  await page.getByRole('heading', { name: 'Configure your plan' }).waitFor();
  assert.equal(await page.locator('input[autocomplete="cc-number"]').count(), 0);
  assert.equal(settled, false);
  assert.equal(await human.isCheckoutPaymentReady(page), false);
  await opening;
  assert.equal(await human.isCheckoutPaymentReady(page), true);
  assert.equal(stats.domContentLoaded, 0);
  stoppedWithoutPayment(stats);
});

for (const [labelDelay, hiddenLabels] of [
  [0, false],
  [250, false],
  [0, true]
]) {
  test(`native opening prepares the card section before strict readiness, label delay ${labelDelay}ms hidden labels ${hiddenLabels}`, async (t) => {
    const { page, stats, start } = await fixture(t, {
      body: `<!doctype html><h1>Configure your plan</h1><p>Due today PHP 9990</p>
        ${hiddenLabels ? '<p style="opacity:0">Card number</p><p inert>Card number</p><p aria-hidden="true">Card number</p>' : ''}
        <div style="height:1800px"></div><section id="payment-method"></section>
        <button onclick="fetch('/fixture-payment-confirm',{method:'POST'})">Subscribe</button>
        <button onclick="fetch('/fixture-unrelated-write',{method:'POST'})">OR</button>
        <script>
          window.mounts=0;
          setTimeout(()=>{
            const section=document.getElementById('payment-method');
            section.innerHTML='<p id="card-label">Card number</p>';
            const observer=new IntersectionObserver(entries=>{
              if(entries.some(entry=>entry.isIntersecting)&&!window.mounts){
                window.mounts++;
                section.insertAdjacentHTML('beforeend','<input autocomplete="cc-number">');
                observer.disconnect();
              }
            });
            observer.observe(document.getElementById('card-label'));
          },${labelDelay});
        </script>`
    });
    await start();
    assert.equal(await page.evaluate(() => window.mounts), 1);
    assert.equal(await human.isCheckoutPaymentReady(page), true);
    assert.equal(stats.documents, 1);
    assert.equal(stats.otherWrites, 0);
    assert.equal(stats.unrelatedWrites, 0);
    stoppedWithoutPayment(stats);
  });
}

test('preparation never clicks a separator or submit label to manufacture card readiness', async (t) => {
  const { stats, start } = await fixture(t, {
    readyWaitMs: 700,
    body: `<h1>Configure your plan</h1>
      <form action="/fixture-payment-confirm" method="POST">
        <button type="submit">Card number</button>
        <button type="submit">OR</button><button type="submit">Subscribe</button>
      </form>`
  });
  await assert.rejects(start(), (error) => {
    assert.equal(error.checkoutOpenDiagnostics.code, 'CHECKOUT_FORM_NOT_READY');
    return true;
  });
  assert.equal(stats.otherWrites, 0);
  stoppedWithoutPayment(stats);
});

test('a permanently empty payment region fails strict readiness without an extra checkout or payment', async (t) => {
  const { stats, start } = await fixture(t, {
    fields: '',
    pendingModule: true,
    maxWaitMs: 3000,
    readyWaitMs: 700
  });
  await assert.rejects(start(), (error) => {
    assert.equal(error.code, 'CHECKOUT_FORM_NOT_READY');
    assert.equal(error.checkoutCreationState, 'accepted');
    assert.equal(error.checkoutOpenDiagnostics.stage, 'readiness');
    assert.equal(error.checkoutOpenDiagnostics.reason, 'not_ready');
    assert.equal(error.checkoutOpenDiagnostics.code, 'CHECKOUT_FORM_NOT_READY');
    assert.deepEqual(error.checkoutOpenDiagnostics.missing, ['number']);
    assert.deepEqual(error.checkoutOpenDiagnostics.candidateCounts, [
      { field: 'number', count: 0 }
    ]);
    assert.equal(error.checkoutOpenDiagnostics.inspection.complete, true);
    return true;
  });
  assert.equal(stats.verifications, 1);
  assert.equal(stats.domContentLoaded, 0);
  stoppedWithoutPayment(stats);
});

for (const scenario of [
  { label: 'unmatched', fields: '<input name="ordinary">', candidates: 0 },
  {
    label: 'ambiguous',
    fields: number + number,
    candidates: 2,
    code: 'CHECKOUT_CONTROL_AMBIGUOUS'
  },
  {
    label: 'readonly excluded',
    fields: '<label>Card number<input autocomplete="cc-number" readonly></label>',
    candidates: 0
  },
  { label: 'read failure', fields: number, candidates: 0, readFailure: true }
]) {
  test(`real browser readiness diagnostics retain ${scenario.label} without payment`, async (t) => {
    const { page, stats, start } = await fixture(t, {
      fields: scenario.fields,
      pendingModule: true,
      maxWaitMs: 4500,
      readyWaitMs: 1000
    });
    if (scenario.readFailure) {
      const frame = page.mainFrame();
      const locator = frame.locator.bind(frame);
      frame.locator = (selector, ...args) => {
        const result = locator(selector, ...args);
        if (selector === 'input,select,textarea,[role="combobox"]') {
          result.evaluateAll = async () => {
            throw new Error('SYNTHETIC_PRIVATE_READ_FAILURE');
          };
        }
        return result;
      };
      t.after(() => {
        frame.locator = locator;
      });
    }
    await assert.rejects(start(), (error) => {
      assert.equal(error.checkoutCreationState, 'accepted');
      const diagnostics = error.checkoutOpenDiagnostics;
      assert.equal(diagnostics.stage, 'readiness');
      assert.equal(diagnostics.reason, 'not_ready');
      assert.deepEqual(diagnostics.missing, ['number']);
      assert.deepEqual(diagnostics.candidateCounts, [
        { field: 'number', count: scenario.candidates }
      ]);
      if (scenario.readFailure) {
        assert.equal(diagnostics.code, 'CHECKOUT_CONTROL_READ_FAILED');
        assert.equal(diagnostics.inspection.complete, false);
        assert.equal(diagnostics.inspection.readPhase, 'frame_scan');
        assert.ok(diagnostics.inspection.framesFailed > 0);
      } else {
        // Readiness reports actual matching candidates. It does not infer why
        // a readonly/disabled field was excluded from its snapshot.
        assert.equal(diagnostics.code, scenario.code || 'CHECKOUT_FORM_NOT_READY');
        assert.equal(diagnostics.inspection.complete, true);
      }
      assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE|selector|value|https|credential/);
      return true;
    });
    stoppedWithoutPayment(stats);
  });
}

test('navigation and readiness consume the same deadline rather than restarting the opening budget', async (t) => {
  const { stats, start } = await fixture(t, {
    fields: '',
    maxWaitMs: 1700,
    readyWaitMs: 60000,
    beforeDocument: () => new Promise((resolve) => setTimeout(resolve, 950))
  });
  const started = performance.now();
  await assert.rejects(start(), (error) => {
    assert.equal(error.checkoutCreationState, 'accepted');
    assert.equal(error.checkoutOpenDiagnostics.stage, 'readiness');
    assert.ok(['timeout', 'not_ready'].includes(error.checkoutOpenDiagnostics.reason));
    return true;
  });
  const elapsed = performance.now() - started;
  assert.ok(stats.verificationBudget.maxWaitMs < 1000);
  assert.ok(stats.goto[0].timeout <= 1700);
  assert.ok(elapsed < 2400, 'the navigation delay must consume the readiness budget');
  stoppedWithoutPayment(stats);
});

test('a real HTTP error stops before verification even if its document has card controls', async (t) => {
  const { stats, start } = await fixture(t, { status: 503 });
  await assert.rejects(start(), (error) => {
    assert.equal(error.code, 'CHECKOUT_OPEN_FAILED');
    assert.deepEqual(error.checkoutOpenDiagnostics, {
      stage: 'navigation',
      reason: 'http_error',
      httpStatus: 503
    });
    assert.doesNotMatch(error.message, /https|cs_test|fixture/);
    return true;
  });
  assert.equal(stats.verifications, 0);
  stoppedWithoutPayment(stats);
});

for (const redirect of [
  `${origin}/checkout/${processorEntity}/cs_test_wrongOriginal`,
  `${origin}/checkout/openai_wrong/${checkoutId}`,
  'https://auth.openai.com/log-in'
]) {
  test(`a real redirect to ${redirect.includes('auth.') ? 'login' : redirect.includes('wrongOriginal') ? 'another order' : 'another entity'} cannot replace the original`, async (t) => {
    const { stats, start } = await fixture(t, { redirect });
    await assert.rejects(start(), (error) => {
      assert.equal(error.code, 'CHECKOUT_OPEN_FAILED');
      assert.deepEqual(error.checkoutOpenDiagnostics, {
        stage: 'navigation',
        reason: 'original_changed'
      });
      return true;
    });
    assert.equal(stats.verifications, 0);
    assert.equal(stats.documents, 2);
    stoppedWithoutPayment(stats);
  });
}

test('visible login on the original page is a login-stage failure rather than readiness', async (t) => {
  const { stats, start } = await fixture(t, { login: true });
  await assert.rejects(start(), (error) => {
    assert.equal(error.code, 'CHECKOUT_OPEN_FAILED');
    assert.deepEqual(error.checkoutOpenDiagnostics, { stage: 'login', reason: 'session_required' });
    return true;
  });
  assert.equal(stats.verifications, 0);
  stoppedWithoutPayment(stats);
});

test('native navigation network errors retain a controlled phase without leaking the original URL', async (t) => {
  const { stats, start } = await fixture(t, { abortNavigation: true });
  await assert.rejects(start(), (error) => {
    assert.equal(error.code, 'CHECKOUT_OPEN_FAILED');
    assert.deepEqual(error.checkoutOpenDiagnostics, {
      stage: 'navigation',
      reason: 'network_error'
    });
    assert.doesNotMatch(error.message, /https|cs_test|net::/);
    return true;
  });
  assert.equal(stats.verifications, 0);
  stoppedWithoutPayment(stats);
});

test('a precommit navigation timeout never enters verification', async (t) => {
  const hold = deferred();
  const { stats, start } = await fixture(t, { maxWaitMs: 700, beforeDocument: () => hold.promise });
  t.after(() => hold.resolve());
  await assert.rejects(start(), (error) => {
    assert.equal(error.code, 'CHECKOUT_OPEN_FAILED');
    assert.deepEqual(error.checkoutOpenDiagnostics, { stage: 'navigation', reason: 'timeout' });
    return true;
  });
  assert.equal(stats.verifications, 0);
  stoppedWithoutPayment(stats);
});

test('lease loss while navigation is pending is preserved and never starts verification', async (t) => {
  const hold = deferred();
  const { stats, start, navigation } = await fixture(t, { beforeDocument: () => hold.promise });
  t.after(() => hold.resolve());
  const opening = start();
  const rejected = assert.rejects(opening, {
    code: 'LEASE_LOST',
    checkoutCreationState: 'accepted'
  });
  await navigation.promise;
  rpc.abortTask(Object.assign(new Error('Synthetic lease expired'), { code: 'LEASE_LOST' }));
  await rejected;
  assert.equal(stats.verifications, 0);
  stoppedWithoutPayment(stats);
});

for (const interruption of ['lease', 'deadline']) {
  test(`${interruption} stops the task page before releasing a late document and keeps other pages alive`, async (t) => {
    const hold = deferred();
    const { page, context, stats, start, navigation } = await fixture(t, {
      maxWaitMs: interruption === 'deadline' ? 700 : 4500,
      beforeDocument: () => hold.promise,
      body:
        '<script>window.lateCheckoutRan=true;recordLateCheckoutScript();fetch("/fixture-late-write",{method:"POST"}).catch(()=>{}).finally(()=>window.lateCheckoutWriteSettled=true);</script>' +
        number
    });
    t.after(() => hold.resolve());
    const otherPage = await context.newPage();
    await otherPage.goto(origin + '/');
    const otherContext = await browser.newContext({ serviceWorkers: 'block' });
    t.after(() => otherContext.close());
    let otherContextWrites = 0;
    await otherContext.route('**/*', (route) => {
      if (route.request().method() === 'POST') otherContextWrites++;
      return route.fulfill({ contentType: 'text/html', body: '<button>Other task</button>' });
    });
    const independentPage = await otherContext.newPage();
    await independentPage.goto(origin + '/');
    const opening = start();
    const rejected = assert.rejects(opening, (error) => {
      assert.equal(error.code, interruption === 'lease' ? 'LEASE_LOST' : 'CHECKOUT_OPEN_FAILED');
      assert.equal(error.checkoutCreationState, 'accepted');
      return true;
    });
    await navigation.promise;
    if (interruption === 'lease')
      rpc.abortTask(Object.assign(new Error('Synthetic lease expired'), { code: 'LEASE_LOST' }));
    await rejected;
    hold.resolve();
    if (!page.isClosed()) {
      await page.waitForFunction(() => window.lateCheckoutRan === true);
      await page.waitForFunction(() => window.lateCheckoutWriteSettled === true).catch(() => {});
    }
    t.diagnostic(
      JSON.stringify({
        interruption,
        taskPageClosed: page.isClosed(),
        lateScripts: stats.lateScripts,
        lateWrites: stats.lateWrites
      })
    );
    assert.equal(
      page.isClosed(),
      true,
      'rejected budget must terminate native navigation, not just its waiter'
    );
    assert.equal(stats.lateScripts, 0);
    assert.equal(stats.lateWrites, 0);
    assert.equal(stats.verifications, 0);
    assert.equal(otherPage.isClosed(), false);
    assert.equal(independentPage.isClosed(), false);
    await otherPage.evaluate(() => fetch('/fixture-unrelated-write', { method: 'POST' }));
    await independentPage.evaluate(() => fetch('/fixture-unrelated-write', { method: 'POST' }));
    assert.equal(stats.unrelatedWrites, 1);
    assert.equal(otherContextWrites, 1);
    assert.equal(browser.isConnected(), true);
    stoppedWithoutPayment(stats);
  });
}

test('an unconfirmed page close keeps a controlled cleanup-failure flag for the owning executor', async (t) => {
  const hold = deferred();
  const { page, stats, start } = await fixture(t, {
    maxWaitMs: 650,
    beforeDocument: () => hold.promise
  });
  const close = page.close.bind(page);
  page.close = async () => {
    throw new Error('PRIVATE_CLOSE_SENTINEL https://private.invalid');
  };
  try {
    await assert.rejects(start(), (error) => {
      assert.equal(error.code, 'CHECKOUT_OPEN_FAILED');
      assert.equal(error.checkoutOpenCleanupFailed, true);
      assert.equal(error.checkoutCreationState, 'accepted');
      assert.equal(error.checkoutOpenDiagnostics.reason, 'timeout');
      assert.doesNotMatch(error.message, /PRIVATE|private\.invalid|https/);
      return true;
    });
    assert.equal(
      page.isClosed(),
      false,
      'the error must not claim a failed protocol close succeeded'
    );
    stoppedWithoutPayment(stats);
  } finally {
    page.close = close;
    await close({ runBeforeUnload: false });
    hold.resolve();
  }
});

test('task cancellation during an empty payment region stops within the same page and budget', async (t) => {
  const { page, stats, start } = await fixture(t, { fields: '', pendingModule: true });
  const opening = start();
  const rejected = assert.rejects(opening, (error) => {
    assert.equal(error.code, 'CHECKOUT_OPEN_FAILED');
    assert.deepEqual(error.checkoutOpenDiagnostics, { stage: 'readiness', reason: 'cancelled' });
    return true;
  });
  await page.getByRole('heading', { name: 'Configure your plan' }).waitFor();
  await page.waitForFunction(() => document.querySelector('#payment-method') !== null);
  // The transparent wrapper records the actual production verification call.
  while (!stats.verifications) await new Promise((resolve) => setImmediate(resolve));
  rpc.abortTask(Object.assign(new Error('Synthetic task cancellation'), { code: 'TASK_ABORTED' }));
  await rejected;
  stoppedWithoutPayment(stats);
});

test('the diagnostics projection accepts only controlled stages, reasons and HTTP status', () => {
  assert.deepEqual(
    safeCheckoutOpenDiagnostics({
      stage: 'navigation',
      reason: 'http_error',
      httpStatus: 503,
      url: originalUrl,
      token: 'synthetic',
      error: { secret: true }
    }),
    { stage: 'navigation', reason: 'http_error', httpStatus: 503 }
  );
  assert.deepEqual(
    safeCheckoutOpenDiagnostics({ stage: 'readiness', reason: 'not_ready', httpStatus: 503 }),
    { stage: 'readiness', reason: 'not_ready' }
  );
  assert.equal(safeCheckoutOpenDiagnostics({ stage: originalUrl, reason: 'timeout' }), undefined);
  assert.equal(
    safeCheckoutOpenDiagnostics({ stage: 'navigation', reason: originalUrl }),
    undefined
  );
  assert.equal(safeCheckoutOpenDiagnostics(null), undefined);
});
