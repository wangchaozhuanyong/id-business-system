'use strict';
/* global document */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('../upstream/node_modules/playwright');
const initialization = require('../checkout-initialization.cjs');
const form = require('../checkout-form.cjs');
const { safeCheckoutOpenDiagnostics } = require('../upstream/chatgpt');
const origin = 'https://chatgpt.com';
const canary = 'synthetic-private-canary';
const forbiddenRead = () => {
  throw Error('diagnostics must not read request/response secrets');
};
function fakePage() {
  const page = new EventEmitter(),
    main = {};
  page.mainFrame = () => main;
  return { page, main };
}
function request(frame, url = 'https://js.stripe.com/v3/?client_secret=' + canary, method = 'GET') {
  return {
    frame: () => frame,
    url: () => url,
    method: () => method,
    failure: () => ({ errorText: 'net::ERR_CONNECTION_CLOSED ' + canary }),
    postData: forbiddenRead,
    headers: forbiddenRead
  };
}
test('endpoint classes use exact official hosts and never return paths or query values', () => {
  for (const [url, expected] of [
    ['https://js.stripe.com/v3/?secret=' + canary, 'stripe_script'],
    ['https://api.stripe.com/v1/elements/sessions', 'stripe_elements'],
    ['https://api.stripe.com/v1/payment_pages/cs_test_private/init', 'stripe_init'],
    ['https://api.stripe.com/v1/payment_pages/cs_test_private/confirm', 'stripe_confirm'],
    ['https://chatgpt.com/checkout/private', 'chatgpt_checkout'],
    ['https://js.stripe.com.attacker.invalid/v3/', 'other'],
    ['https://fake.invalid/js.stripe.com', 'other'],
    ['https://user:password@api.stripe.com/v1/elements/sessions', 'other'],
    ['not a URL', 'other']
  ])
    assert.equal(initialization.endpoint(url), expected);
});
test('network errors retain controlled categories only', () => {
  for (const [raw, expected] of [
    ['net::ERR_NAME_NOT_RESOLVED', 'DNS_FAILED'],
    ['net::ERR_PROXY_AUTH_REQUESTED', 'PROXY_AUTH_FAILED'],
    ['net::ERR_TUNNEL_CONNECTION_FAILED', 'PROXY_TUNNEL_FAILED'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'TLS_FAILED'],
    ['net::ERR_CONNECTION_RESET', 'CONNECTION_RESET'],
    ['net::ERR_CONNECTION_REFUSED', 'CONNECTION_REFUSED'],
    ['net::ERR_TIMED_OUT', 'TIMEOUT'],
    ['net::ERR_BLOCKED_BY_CLIENT', 'BLOCKED_BY_CLIENT'],
    ['net::ERR_BLOCKED_BY_CSP', 'BLOCKED_BY_CSP'],
    ['net::ERR_ABORTED', 'ABORTED'],
    [canary, 'NETWORK_FAILED']
  ])
    assert.equal(initialization.networkCode(raw), expected);
});
test('route abort records the exact rule and original arguments without changing cancellation', async () => {
  const { page, main } = fakePage();
  main.page = () => page;
  const observer = initialization.observe(page);
  const req = request(main, origin + '/auth/signin?token=' + canary);
  req.resourceType = () => 'document';
  req.failure = () => ({ errorText: 'net::ERR_FAILED' });
  const argumentsSeen = [];
  await initialization.abortRoute(
    {
      request: () => req,
      abort: async (...args) => {
        argumentsSeen.push(args);
        page.emit('requestfailed', req);
      }
    },
    'SESSION_OFFICIAL_LOGIN'
  );
  const result = observer.snapshot();
  observer.dispose();
  assert.deepEqual(argumentsSeen, [[]]);
  assert.equal(result.firstFailure.source, 'our_route_abort');
  assert.equal(result.firstFailure.failureCode, 'ERR_FAILED');
  assert.equal(result.firstFailure.ruleId, 'SESSION_OFFICIAL_LOGIN');
  assert.equal(result.firstFailure.resourceType, 'document');
  const decisions = result.events.filter((row) => row.event === 'route_abort');
  assert.deepEqual(
    decisions.map((row) => row.abortState),
    ['requested', 'completed']
  );
  assert.equal(decisions[0].requestId, result.firstFailure.requestId);
  assert.equal(JSON.stringify(result).includes(canary), false);
});
test('navigation timing stays a same-frame possible relation and never becomes an abort cause', () => {
  const { page, main } = fakePage();
  main.url = () => origin + '/checkout/oaics_' + canary;
  const child = { url: main.url };
  const observer = initialization.observe(page);
  const req = request(main);
  req.failure = () => ({ errorText: 'net::ERR_ABORTED' });
  page.emit('requestfailed', req);
  page.emit('framedetached', child);
  assert.equal(observer.snapshot().firstFailure.navigationRelated, undefined);
  page.emit('framenavigated', main);
  const result = observer.snapshot();
  observer.dispose();
  assert.equal(result.firstFailure.source, 'unknown_abort');
  assert.equal(result.firstFailure.failureCode, 'ERR_ABORTED');
  assert.equal(result.firstFailure.navigationRelated, 'possible');
  assert.equal(result.firstFailure.ruleId, undefined);
  assert.equal(JSON.stringify(result).includes(canary), false);
});
test('failed route cancellation retains its original error and an explicit failed receipt', async () => {
  const { page, main } = fakePage();
  main.page = () => page;
  const observer = initialization.observe(page);
  const original = new Error(canary);
  await assert.rejects(
    initialization.abortRoute(
      {
        request: () => request(main),
        abort: async () => {
          throw original;
        }
      },
      'RELOAD_FRAME',
      'blockedbyclient'
    ),
    (error) => error === original
  );
  const result = observer.snapshot();
  observer.dispose();
  assert.equal(result.events.at(-1).abortState, 'failed');
  assert.equal(JSON.stringify(result).includes(canary), false);
});
test('CDP cancellation is logged without inventing a Playwright request correlation', async () => {
  const { page, main } = fakePage();
  const observer = initialization.observe(page);
  await initialization.observeCancellation(
    page,
    request(main),
    'RELOAD_CDP',
    async () => {},
    false
  );
  const req = request(main);
  req.failure = () => ({ errorText: 'net::ERR_ABORTED' });
  page.emit('requestfailed', req);
  const result = observer.snapshot();
  observer.dispose();
  assert.equal(result.firstFailure.source, 'unknown_abort');
  assert.ok(
    result.events.some((row) => row.event === 'route_abort' && row.ruleId === 'RELOAD_CDP')
  );
});
test('route templates discard checkout IDs, arbitrary query names, JWTs and nonofficial paths', () => {
  for (const [url, template] of [
    [origin + '/api/auth/session?secret_' + canary + '=value', 'auth_session'],
    [origin + '/api/auth/csrf', 'auth_csrf'],
    [origin + '/checkout/openai/cs_live_' + canary, 'checkout_page'],
    ['https://api.stripe.com/v1/payment_pages/cs_live_' + canary + '/init', 'stripe_init'],
    ['https://untrusted.invalid/' + canary, 'other']
  ])
    assert.equal(initialization.routeTemplate(url), template);
});
test('HTTP failures are recorded without requestfailed and without reading bodies or headers', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page),
    req = request(main);
  page.emit('request', req);
  page.emit('response', {
    request: () => req,
    status: () => 503,
    text: forbiddenRead,
    headers: forbiddenRead
  });
  const result = observer.snapshot();
  observer.dispose();
  assert.equal(result.firstFailure.status, 503);
  assert.equal(result.firstFailure.event, 'response');
  assert.equal(
    result.events.some((e) => e.event === 'request_failed'),
    false
  );
  assert.equal(JSON.stringify(result).includes(canary), false);
});
test('a full timeline still retains the first later failure', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page),
    req = request(main);
  for (let i = 0; i < 200; i++) page.emit('request', req);
  page.emit('requestfailed', req);
  const result = observer.snapshot();
  observer.dispose();
  assert.equal(result.events.length, 64);
  assert.equal(result.eventCount, 201);
  assert.equal(result.truncated, true);
  assert.equal(result.firstFailure.code, 'CONNECTION_CLOSED');
});
test('later SDK failures remain classified after normal traffic fills the timeline', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page);
  page.emit('response', {
    request: () => request(main, 'https://chatgpt.com/api/auth/session'),
    status: () => 403
  });
  for (let n = 0; n < 100; n++) page.emit('request', request(main));
  for (let n = 0; n < 3; n++)
    page.emit('console', {
      type: () => 'error',
      text: () => 'Stripe initCheckout failed ' + canary,
      location: () => ({ url: 'https://js.stripe.com/v3/?private=' + canary })
    });
  const result = observer.snapshot();
  assert.equal(result.events.length, 64);
  assert.equal(result.truncated, true);
  assert.equal(result.firstFailure.endpoint, 'chatgpt_auth');
  assert.equal(result.failureClasses.length, 2);
  assert.equal(result.failureClasses[1].code, 'SDK_INITIALIZATION_FAILED');
  assert.equal(result.failureClasses[1].count, 3);
  assert.equal(JSON.stringify(result).includes(canary), false);
  for (let status = 400; status < 435; status++)
    page.emit('response', {
      request: () => request(main),
      status: () => status
    });
  const bounded = observer.snapshot();
  assert.equal(bounded.failureClasses.length, 32);
  assert.equal(bounded.failureClassesTruncated, true);
  const extra = structuredClone(bounded);
  extra.failureClasses[0].raw = canary;
  assert.equal(initialization.sanitize(extra), undefined);
  const invalidCount = structuredClone(bounded);
  invalidCount.failureClasses[0].count = -1;
  assert.equal(initialization.sanitize(invalidCount), undefined);
  observer.dispose();
});

test('task cancellation removes observers and isolates another task page', () => {
  const a = fakePage(),
    b = fakePage(),
    controller = new AbortController();
  const first = initialization.observe(a.page, { signal: controller.signal }),
    second = initialization.observe(b.page);
  controller.abort();
  a.page.emit('requestfailed', request(a.main));
  b.page.emit('requestfailed', request(b.main));
  assert.equal(first.snapshot().eventCount, 0);
  assert.equal(a.page.listenerCount('requestfailed'), 0);
  assert.equal(second.snapshot().eventCount, 1);
  second.dispose();
  second.dispose();
  assert.equal(b.page.listenerCount('response'), 0);
});
test('raw script errors and CSP messages cannot enter the stored result', () => {
  const { page } = fakePage(),
    observer = initialization.observe(page);
  page.emit('pageerror', Object.assign(new Error(canary), { name: 'TypeError' }));
  page.emit('console', {
    type: () => 'error',
    text: () => `Refused: Content Security Policy script-src '${canary}'`,
    location: () => ({ url: origin + '/private?' + canary })
  });
  const result = observer.snapshot();
  observer.dispose();
  assert.equal(result.events[0].code, 'JS_TYPE_ERROR');
  assert.equal(result.events[1].directive, 'script-src');
  assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(JSON.stringify(result).includes('https://'), false);
});
test('uncontrolled properties and values are rejected by the existing result projection', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page);
  page.emit('requestfailed', request(main));
  const result = observer.snapshot();
  observer.dispose();
  assert.deepEqual(
    safeCheckoutOpenDiagnostics({
      stage: 'navigation',
      reason: 'network_error',
      initialization: result
    }).initialization,
    result
  );
  for (const value of [
    { ...result, url: canary },
    { ...result, events: [{ ...result.events[0], body: canary }] },
    { ...result, events: [{ ...result.events[0], code: canary }] },
    { ...result, firstFailure: { ...result.firstFailure, endpoint: canary } }
  ]) {
    assert.equal(initialization.sanitize(value), undefined);
    assert.equal(
      safeCheckoutOpenDiagnostics({
        stage: 'readiness',
        reason: 'not_ready',
        initialization: value
      }).initialization,
      undefined
    );
  }
});
test('a broken optional observer cannot throw into checkout execution', () => {
  const { page } = fakePage(),
    observer = initialization.observe(page);
  page.emit('request', {
    url() {
      throw Error(canary);
    }
  });
  assert.equal(observer.snapshot().readFailures, 1);
  observer.dispose();
});

test('a request before frame creation retains its HTTP and network failure evidence', () => {
  const { page } = fakePage(),
    observer = initialization.observe(page),
    req = request(null);
  req.frame = () => {
    throw Error('Frame unavailable: ' + canary);
  };
  page.emit('response', { request: () => req, status: () => 503 });
  page.emit('requestfailed', req);
  const result = observer.snapshot();
  observer.dispose();
  assert.equal(result.events.length, 2);
  assert.ok(result.events.every((row) => row.frame === 'unknown'));
  assert.equal(result.firstFailure.status, 503);
  assert.equal(result.events[1].code, 'CONNECTION_CLOSED');
  assert.equal(result.readFailures, 2);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test('handled SDK and CORS console errors retain only controlled causes', () => {
  const { page } = fakePage(),
    observer = initialization.observe(page);
  for (const text of [
    `Stripe initCheckout failed ${canary}`,
    `CORS policy ${canary}`,
    `Invalid publishable Key: ${canary}`,
    `invalid client_secret: ${canary}`
  ])
    page.emit('console', {
      type: () => 'error',
      text: () => text,
      location: () => ({ url: 'https://js.stripe.com/private?' + canary })
    });
  const result = observer.snapshot();
  observer.dispose();
  assert.deepEqual(
    result.events.map((e) => e.code),
    [
      'SDK_INITIALIZATION_FAILED',
      'CORS_BLOCKED',
      'STRIPE_KEY_INVALID',
      'STRIPE_CLIENT_SECRET_INVALID'
    ]
  );
  assert.equal(JSON.stringify(result).includes(canary), false);
});

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
});
test.after(async () => browser?.close());
async function fixture(t, options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const stats = { init: 0, payment: 0, unexpected: 0 };
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin === origin && url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        headers: options.csp
          ? { 'content-security-policy': "default-src 'self'; script-src 'self'; frame-src 'self'" }
          : {},
        body:
          '<h1>Configure your plan</h1><p>PHP 9990</p><div id="skeleton">Payment loading</div>' +
          (options.embedded
            ? '<iframe src="https://js.stripe.com/fixture-frame.html"></iframe>'
            : '<script src="https://js.stripe.com/v3/?client_secret=' + canary + '"></script>')
      });
    if (url.hostname === 'js.stripe.com' && url.pathname === '/fixture-frame.html')
      return route.fulfill({
        contentType: 'text/html',
        body: `<script>fetch('https://api.stripe.com/v1/payment_pages/cs_test_${canary}/init', {method:'POST',body:'private=${canary}'}).then(r=>r.ok&&parent.postMessage('ready','*'));</script>`
      });
    if (url.hostname === 'api.stripe.com' && /\/init$/.test(url.pathname)) {
      stats.init++;
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: '{}'
      });
    }
    if (url.hostname === 'js.stripe.com' && url.pathname === '/v3/') {
      if (options.abort) return route.abort(options.abort);
      return route.fulfill({
        status: options.status || 200,
        contentType: 'application/javascript',
        body: options.consoleError
          ? `console.error('Stripe initCheckout rejected ${canary}');`
          : options.status
            ? ''
            : "document.querySelector('#skeleton').remove();document.body.insertAdjacentHTML('beforeend','<input autocomplete=cc-number>');"
      });
    }
    if (req.method() === 'POST') stats.payment++;
    else stats.unexpected++;
    return route.abort('blockedbyclient');
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  const page = await context.newPage(),
    observer = initialization.observe(page);
  t.after(async () => {
    observer.dispose();
    await context.close();
  });
  await page.goto(origin + '/');
  return { page, observer, stats };
}
test('real Chromium distinguishes failed Stripe script connection from absent card selectors', async (t) => {
  const { page, observer, stats } = await fixture(t, { abort: 'connectionrefused' });
  assert.equal(
    (await form.inspectCardReadiness(page, { deadline: Date.now() + 2000 })).ready,
    false
  );
  assert.equal(observer.snapshot().firstFailure.endpoint, 'stripe_script');
  assert.equal(observer.snapshot().firstFailure.code, 'CONNECTION_REFUSED');
  assert.equal(stats.payment, 0);
  assert.equal(stats.unexpected, 0);
});
test('real Chromium retains an HTTP 503 independently from a later browser script cancellation', async (t) => {
  const { observer, stats } = await fixture(t, { status: 503 });
  assert.equal(observer.snapshot().firstFailure.endpoint, 'stripe_script');
  assert.equal(observer.snapshot().firstFailure.status, 503);
  assert.equal(
    observer.snapshot().requestCounts.find((row) => row.endpoint === 'stripe_script').responses,
    1
  );
  assert.equal(stats.payment, 0);
});

test('real caught SDK initialization error is retained without an uncaught pageerror', async (t) => {
  const { page, observer, stats } = await fixture(t, { consoleError: true });
  assert.equal(observer.snapshot().firstFailure.event, 'console_error');
  assert.equal(observer.snapshot().firstFailure.code, 'SDK_INITIALIZATION_FAILED');
  assert.equal(
    (await form.inspectCardReadiness(page, { deadline: Date.now() + 2000 })).ready,
    false
  );
  assert.equal(stats.payment, 0);
  assert.equal(JSON.stringify(observer.snapshot()).includes(canary), false);
});
test('real cross-origin Stripe frame initialization is observed without admitting another write', async (t) => {
  const { page, observer, stats } = await fixture(t, { embedded: true });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow !== null);
  await assertEventually(() =>
    observer.snapshot().events.some((e) => e.endpoint === 'stripe_init' && e.status === 403)
  );
  const failure = observer
    .snapshot()
    .events.find((e) => e.endpoint === 'stripe_init' && e.status === 403);
  assert.equal(failure.method, 'POST');
  assert.equal(failure.frame, 'embedded');
  assert.equal(failure.ownerEndpoint, 'stripe_frame');
  assert.ok(
    observer
      .snapshot()
      .criticalEvents.some(
        (row) => row.event === 'frame_navigated' && row.endpoint === 'stripe_frame'
      )
  );
  assert.equal(stats.init, 1);
  assert.equal(stats.payment, 0);
  assert.equal(JSON.stringify(observer.snapshot()).includes(canary), false);
});
async function assertEventually(predicate) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), 'expected native browser event did not arrive');
}
test('real CSP failure is recorded while the browser policy remains effective', async (t) => {
  const { page, observer, stats } = await fixture(t, { csp: true });
  await assertEventually(() => observer.snapshot().events.some((e) => e.event === 'csp'));
  assert.equal(await page.locator('input[autocomplete="cc-number"]').count(), 0);
  assert.equal(
    observer.snapshot().events.some((e) => e.event === 'csp' && e.code === 'BLOCKED_BY_CSP'),
    true
  );
  assert.equal(stats.payment, 0);
});
test('a normally mounted synthetic payment control stays usable with the observer installed', async (t) => {
  const { page, observer, stats } = await fixture(t);
  await assertEventually(() =>
    observer
      .snapshot()
      .criticalEvents.some(
        (row) => row.event === 'request_finished' && row.endpoint === 'stripe_script'
      )
  );
  assert.equal(
    (await form.inspectCardReadiness(page, { deadline: Date.now() + 2000 })).ready,
    true
  );
  assert.equal(observer.snapshot().firstFailure, null);
  assert.equal(stats.payment, 0);
  assert.equal(stats.init, 0);
  assert.equal(stats.unexpected, 0);
});

test('response headers do not finish a request; download completion clears its pending entry', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page);
  const req = request(main);
  req.resourceType = () => 'script';
  page.emit('request', req);
  page.emit('response', {
    request: () => req,
    status: () => 503,
    headers: forbiddenRead,
    body: forbiddenRead
  });
  const headers = observer.snapshot();
  assert.equal(headers.version, 2);
  assert.equal(headers.pendingRequestCount, 1);
  assert.equal(headers.pendingRequests[0].status, 503);
  assert.equal(headers.requestCounts[0].finished, 0);
  page.emit('requestfinished', req);
  const completed = observer.snapshot();
  assert.equal(completed.pendingRequestCount, 0);
  assert.equal(completed.pendingRequests.length, 0);
  assert.equal(completed.requestCounts[0].finished, 1);
  assert.equal(completed.requestCounts[0].failed, 0);
  assert.equal(completed.firstFailure.status, 503);
  assert.ok(
    completed.criticalEvents.some((row) => row.event === 'request_finished' && row.durationMs >= 0)
  );
  observer.dispose();
  assert.equal(JSON.stringify(completed).includes(canary), false);
});

test('general traffic cannot hide later payment requests, frame lifecycle and owning frame category', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page);
  for (let n = 0; n < 400; n++)
    page.emit('request', request(main, origin + '/assets/' + n + canary));
  const child = { url: () => 'https://js.stripe.com/v3/payment-frame.html?private=' + canary };
  page.emit('frameattached', child);
  page.emit('framenavigated', child);
  const req = request(child, 'https://unclassified.invalid/private/' + canary);
  req.resourceType = () => 'script';
  page.emit('request', req);
  page.emit('requestfailed', req);
  const snapshot = observer.snapshot();
  observer.dispose();
  assert.equal(snapshot.events.length, 64);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.criticalTruncated, false);
  assert.ok(
    snapshot.criticalEvents.some(
      (row) => row.event === 'frame_navigated' && row.endpoint === 'stripe_frame'
    )
  );
  assert.equal(snapshot.firstFailure.ownerEndpoint, 'stripe_frame');
  assert.equal(snapshot.firstFailure.endpoint, 'other');
  assert.equal(snapshot.firstFailure.resourceType, 'script');
  assert.equal(snapshot.firstFailure.source, 'network_or_proxy');
  assert.ok(
    snapshot.criticalEvents.some(
      (row) => row.event === 'request_failed' && row.ownerEndpoint === 'stripe_frame'
    )
  );
  assert.equal(JSON.stringify(snapshot).includes(canary), false);
});

test('bounded pending inventory prioritizes payment evidence and declares missing entries', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page);
  for (let n = 0; n < 70; n++) page.emit('request', request(main, origin + '/assets/' + n));
  const req = request(main, 'https://api.stripe.com/v1/elements/sessions?private=' + canary);
  page.emit('request', req);
  page.emit('response', { request: () => req, status: () => 200 });
  const pending = observer.snapshot();
  assert.equal(pending.pendingRequestCount, 71);
  assert.equal(pending.pendingRequests.length, 48);
  assert.equal(pending.pendingRequestsTruncated, true);
  assert.ok(
    pending.pendingRequests.some((row) => row.endpoint === 'stripe_elements' && row.status === 200)
  );
  page.emit('requestfailed', req);
  observer.dispose();
  const final = observer.snapshot();
  assert.equal(final.pendingRequestCount, 70);
  assert.equal(final.requestCounts.find((row) => row.endpoint === 'stripe_elements').failed, 1);
  assert.equal(
    final.pendingRequests.some((row) => row.endpoint === 'stripe_elements'),
    false
  );
  page.emit('requestfinished', request(main));
  assert.deepEqual(observer.snapshot(), final, 'cleanup must not advance frozen timing or counts');
});

test('critical timeline retains first and latest halves and explicitly marks overflow', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page);
  for (let n = 0; n < 150; n++) page.emit('request', request(main));
  const rows = observer.snapshot();
  observer.dispose();
  assert.equal(rows.criticalEvents.length, 96);
  assert.equal(rows.criticalEventCount, 150);
  assert.equal(rows.criticalTruncated, true);
  assert.equal(rows.criticalEvents[0].requestId, 1);
  assert.equal(rows.criticalEvents.at(-1).requestId, 150);
});

test('document URLs and non-script Stripe resources are never mislabeled as SDK downloads', () => {
  assert.equal(initialization.endpoint('https://js.stripe.com/v3/', 'document'), 'stripe_frame');
  assert.equal(
    initialization.endpoint('https://js.stripe.com/v3/payment.html?secret=' + canary),
    'stripe_frame'
  );
  assert.equal(
    initialization.endpoint('https://js.stripe.com/v3/private', 'script'),
    'stripe_script'
  );
  assert.equal(
    initialization.endpoint('https://js.stripe.com/v3/private', 'fetch'),
    'stripe_other'
  );
});

test('version two rejects uncontrolled nested fields while stored version one remains readable', () => {
  const { page, main } = fakePage(),
    observer = initialization.observe(page);
  page.emit('request', request(main));
  const value = observer.snapshot();
  observer.dispose();
  for (const mutate of [
    (v) => {
      v.criticalEvents[0].rawUrl = canary;
    },
    (v) => {
      v.pendingRequests[0].ownerEndpoint = canary;
    },
    (v) => {
      v.requestCounts[0].body = canary;
    },
    (v) => {
      v.requestCounts[0].pending = -1;
    },
    (v) => {
      v.criticalEventCount = 0;
    },
    (v) => {
      v.pendingRequests[0].responseMs = 3600001;
    }
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.equal(initialization.sanitize(invalid), undefined);
  }
  const legacy = {
    version: 1,
    elapsedMs: 20,
    events: [],
    firstFailure: null,
    failureClasses: [],
    failureClassesTruncated: false,
    eventCount: 0,
    readFailures: 0,
    truncated: false
  };
  assert.deepEqual(initialization.sanitize(legacy), legacy);
  assert.equal(
    require('../security.cjs').sanitizeResult({ checkoutInitialization: value })
      .checkoutInitialization.version,
    2
  );
});
