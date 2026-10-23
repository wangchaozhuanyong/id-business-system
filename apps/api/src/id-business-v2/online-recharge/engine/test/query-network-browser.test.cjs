'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateKeyPairSync } = require('node:crypto');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { runInNewContext } = require('node:vm');
const { chromium } = require('../upstream/node_modules/playwright');
const { querySubscriptionBySession } = require('../upstream/subscription-check');

const token = 'synthetic-browser-network-token';
const origin = 'https://chatgpt.com';
const accountId = 'synthetic-browser-network-account';
const accountBody = {
  accounts: {
    default: {
      account: { account_id: accountId },
      entitlement: { has_active_subscription: false, subscription_plan: 'free' },
      last_active_subscription: {}
    }
  }
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;

test.before(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-features=BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks']
  });
});

test.after(async () => {
  await browser?.close();
});

// This synthetic key never leaves process memory. The listener is loopback-only;
// every official-domain request is fulfilled or rewritten before network access.
function certificate() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ format: 'pem', type: 'pkcs8' });
  // Node's child stdio can be a socket, which Linux cannot reopen as a file.
  // A fixed shell pipeline gives OpenSSL a real OS pipe for its read-only key
  // input. The key is supplied only through stdin; no key file is created.
  const cert = execFileSync(
    '/bin/sh',
    ['-c', 'cat | openssl req -new -x509 -key /dev/stdin -sha256 -days 1 -subj /CN=localhost'],
    { input: key, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
  );
  return { key, cert };
}

const tls = certificate();

async function fixture(t, handleAccountCheck, { routeError, cookieId = accountId } = {}) {
  const seen = {
    accountRequests: [],
    originalRequests: [],
    sessionRequests: 0,
    checkoutRequests: 0,
    mutationRequests: 0,
    closedRequests: 0,
    externalRequests: [],
    failures: []
  };
  const timers = new Set();
  const server = https.createServer(tls, (request, response) => {
    if (request.method !== 'GET') seen.mutationRequests++;
    if (/checkout|payment|subscribe/.test(request.url)) seen.checkoutRequests++;
    const record = {
      method: request.method,
      path: request.url,
      cookie: request.headers.cookie || '',
      bearer: request.headers.authorization,
      closed: false,
      aborted: false
    };
    seen.accountRequests.push(record);
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-credentials', 'true');
    response.setHeader('content-type', 'application/json');
    response.on('close', () => {
      record.closed = true;
      record.aborted = !response.writableEnded;
      seen.closedRequests++;
    });
    const later = (ms, action) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        action();
      }, ms);
      timers.add(timer);
    };
    handleAccountCheck(request, response, record, later);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = `https://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([
    {
      name: 'synthetic-query-session',
      value: cookieId,
      domain: 'chatgpt.com',
      path: '/',
      secure: true
    }
  ]);
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      seen.externalRequests.push(url.origin);
      return route.abort();
    }
    if (request.method() !== 'GET') {
      seen.mutationRequests++;
      return route.abort();
    }
    if (/checkout|payment|subscribe/.test(url.pathname)) {
      seen.checkoutRequests++;
      return route.abort();
    }
    if (url.pathname.startsWith('/backend-api/accounts/check/')) {
      seen.originalRequests.push({
        cookie: request.headers().cookie || '',
        bearer: request.headers().authorization
      });
      if (routeError) return route.abort(routeError);
      return route.continue({ url: `${target}${url.pathname}${url.search}` });
    }
    if (url.pathname === '/api/auth/session') {
      seen.sessionRequests++;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ accessToken: token, user: { id: 'synthetic-user' } })
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body>Isolated logged-in query fixture</body></html>'
    });
  });
  // APIRequestContext is deliberately unavailable: these checks exercise the
  // same Chromium fetch used by an already authenticated recharge page.
  context.request.get = async () => assert.fail('Unexpected alternate query transport');
  context.request.post = async () => assert.fail('Unexpected external mutation');
  const page = await context.newPage();
  page.on('requestfailed', (request) => seen.failures.push(request.failure()?.errorText));
  await page.goto(origin);
  const auth = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session');
    const data = await response.json();
    return { status: response.status, hasAccessToken: Boolean(data.accessToken) };
  });
  assert.deepEqual(auth, { status: 200, hasAccessToken: true });
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await context.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { page, context, seen, cookieId };
}

function noPayment(seen, cookieId = accountId) {
  assert.equal(seen.sessionRequests, 1);
  assert.equal(seen.mutationRequests, 0, 'No payment or other mutation is permitted');
  assert.equal(seen.checkoutRequests, 0, 'A failed precheck must not create a checkout');
  assert.deepEqual(seen.externalRequests, []);
  assert.ok(seen.accountRequests.every((request) => request.method === 'GET'));
  assert.ok(
    seen.originalRequests.every((request) =>
      request.cookie.includes(`synthetic-query-session=${cookieId}`)
    )
  );
  assert.ok(seen.accountRequests.every((request) => request.bearer === `Bearer ${token}`));
}

async function requestAborted(record) {
  const until = performance.now() + 200;
  while (!record.aborted && performance.now() < until) await delay(10);
  assert.equal(record.aborted, true, 'The real GET must be cancelled before a later attempt');
}

function queryWithoutUnrelatedProbe(overrides = {}) {
  const filename = path.join(__dirname, '../upstream/subscription-check.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    Buffer,
    URL,
    Date,
    AbortController,
    console,
    process: { env: {} },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      // Keep the network implementation unchanged, but avoid an earlier DOM
      // verification probe consuming the deliberately blocked page's deadline.
      if (name === './human-verification')
        return { isBlockingHumanVerificationVisible: async () => false };
      return localRequire(name);
    }
  });
  return module.exports.querySubscriptionBySession;
}

function ownedQuery(f, { onLogin = () => {}, onContext = () => {}, onCleanup = () => {} } = {}) {
  return queryWithoutUnrelatedProbe({
    './session-auth': {
      extractProfileFromToken: () => ({ accountId }),
      installChatGptSession: async (context) => {
        assert.equal(context, f.context);
        return { cookieVerified: true, sessionData: { accessToken: token } };
      },
      bootstrapChatGptSession: async (page) => {
        onLogin();
        await page.goto(origin);
        return { session: { accessToken: token } };
      }
    },
    './browser-runtime': {
      connectTaskBrowser: async () => ({
        browser: {
          newContext: async () => {
            onContext();
            return f.context;
          }
        }
      }),
      closeTaskBrowser: async () => {}
    },
    './playwright-proxy': {
      preparePlaywrightProxy: async () => ({ cleanup: async () => onCleanup() })
    }
  });
}

test('real Chromium auth 200 does not authorize a business 401 or any checkout', async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(401);
    response.end(JSON.stringify({ error: 'synthetic unauthorized' }));
  });
  const result = await querySubscriptionBySession(token, {
    page: f.page,
    browserContext: f.context
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'SESSION_INVALID', JSON.stringify({ result, seen: f.seen }));
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].httpStatus, 401);
  assert.equal(result.diagnostics[0].requestIssued, true);
  assert.equal(result.diagnostics[0].responseHeadersReceived, true);
  assert.equal(result.diagnostics[0].responseBodyCompleted, true);
  const network = result.diagnostics[0].network;
  assert.equal(network.available, true);
  assert.equal(network.originReceiptProven, false);
  assert.ok(network.events.some((row) => row.event === 'browser_request'));
  assert.ok(
    network.events.some((row) => row.event === 'response_headers' && row.httpStatus === 401)
  );
  assert.equal(network.proxy.providerStatisticsAvailable, false);
  assert.equal(typeof result.diagnostics[0].resourceTiming.observed, 'boolean');
  assert.ok(!JSON.stringify(network).includes(token));
  assert.equal(f.seen.accountRequests.length, 1);
  assert.equal(f.page.isClosed(), false);
  noPayment(f.seen);
});

test('real Chromium delayed headers reaches the shared deadline without a checkout', async (t) => {
  const f = await fixture(t, (_request, response, _record, later) => {
    later(1000, () => response.end(JSON.stringify(accountBody)));
  });
  const result = await querySubscriptionBySession(token, {
    page: f.page,
    browserContext: f.context,
    deadlineAt: performance.now() + 400
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NETWORK_TIMEOUT');
  assert.equal(f.seen.accountRequests.length, 1);
  assert.ok(result.diagnostics.length <= 2);
  assert.equal(result.diagnostics[0].requestIssued, true);
  assert.equal(result.diagnostics[0].responseHeadersReceived, false);
  assert.equal(result.diagnostics[0].responseBodyCompleted, false);
  assert.equal(result.diagnostics[0].failurePhase, 'response_headers');
  assert.equal(result.diagnostics[0].network.available, true);
  assert.ok(result.diagnostics[0].network.events.some((row) => row.event === 'browser_request'));
  assert.ok(!result.diagnostics[0].network.events.some((row) => row.event === 'response_headers'));
  assert.equal(result.diagnostics[0].timeoutSource, 'query_deadline');
  await requestAborted(f.seen.accountRequests[0]);
  assert.equal(f.page.isClosed(), false);
  noPayment(f.seen);
});

test('unavailable diagnostic attachment and resource timing cannot block the real subscription GET', async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.end(JSON.stringify(accountBody));
  });
  f.context.newCDPSession = async () => new Promise(() => {});
  await f.page.evaluate(() => {
    performance.getEntriesByName = () => {
      throw Error('synthetic unavailable timing');
    };
  });
  const result = await querySubscriptionBySession(token, {
    page: f.page,
    browserContext: f.context,
    deadlineAt: performance.now() + 2000
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics[0].network.available, false);
  assert.equal(result.diagnostics[0].resourceTiming.observed, false);
  assert.equal(f.seen.accountRequests.length, 1);
  noPayment(f.seen);
});

test('real Chromium received headers with a stalled body cannot be treated as subscription success', async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.flushHeaders();
    response.write('{"accounts":');
  });
  const result = await querySubscriptionBySession(token, {
    page: f.page,
    browserContext: f.context,
    deadlineAt: performance.now() + 400
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NETWORK_TIMEOUT');
  assert.equal(f.seen.accountRequests.length, 1);
  assert.equal(result.diagnostics[0].requestIssued, true);
  assert.equal(result.diagnostics[0].responseHeadersReceived, true);
  assert.equal(result.diagnostics[0].responseBodyCompleted, false);
  assert.equal(result.diagnostics[0].httpStatus, 200);
  assert.equal(result.diagnostics[0].failurePhase, 'response_body');
  assert.equal(result.diagnostics[0].timeoutSource, 'query_deadline');
  assert.ok(result.diagnostics[0].headersElapsedMs >= 0);
  assert.ok(result.diagnostics[0].bodyElapsedMs >= 0);
  await requestAborted(f.seen.accountRequests[0]);
  assert.equal(f.page.isClosed(), false);
  noPayment(f.seen);
});

test('real Chromium transient connection resets are attempted at most twice with the same context', async (t) => {
  const f = await fixture(t, () => assert.fail('Aborted route must not reach the listener'), {
    routeError: 'connectionreset'
  });
  const result = await querySubscriptionBySession(token, {
    page: f.page,
    browserContext: f.context,
    deadlineAt: performance.now() + 2500
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(f.seen.originalRequests.length, 2);
  assert.equal(f.seen.accountRequests.length, 0);
  noPayment(f.seen);
});

test(
  'real Chromium lease cancellation aborts the active read and never consumes a late response',
  { timeout: 5000 },
  async (t) => {
    const control = new AbortController();
    let issued;
    const requestIssued = new Promise((resolve) => {
      issued = resolve;
    });
    const f = await fixture(t, (_request, response, _record, later) => {
      issued();
      later(350, () => response.end(JSON.stringify(accountBody)));
    });
    const pending = querySubscriptionBySession(token, {
      page: f.page,
      browserContext: f.context,
      signal: control.signal,
      deadlineAt: performance.now() + 1500
    });
    await requestIssued;
    control.abort();
    await assert.rejects(pending, { code: 'LEASE_LOST' });
    await requestAborted(f.seen.accountRequests[0]);
    await delay(400);
    assert.equal(f.seen.accountRequests.length, 1);
    assert.equal(f.page.isClosed(), true, 'Lease loss closes only the task page');
    assert.equal(browser.isConnected(), true, 'Lease loss must not close the pool browser');
    noPayment(f.seen);
  }
);

test('real Chromium concurrent query contexts never share their original cookies', async (t) => {
  const fixtures = [];
  for (const id of ['synthetic-first-context', 'synthetic-second-context']) {
    fixtures.push(
      await fixture(t, (_request, response) => response.end(JSON.stringify(accountBody)), {
        cookieId: id
      })
    );
  }
  const results = await Promise.all(
    fixtures.map((f) =>
      querySubscriptionBySession(token, { page: f.page, browserContext: f.context })
    )
  );
  assert.ok(results.every((result) => result.ok));
  for (const f of fixtures) {
    assert.equal(f.seen.accountRequests.length, 1);
    noPayment(f.seen, f.cookieId);
    for (const other of fixtures.filter((item) => item !== f)) {
      assert.equal(f.seen.originalRequests[0].cookie.includes(other.cookieId), false);
    }
  }
});

test('read-only comparison cannot replace a failed business read inside a supplied checkout context', async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(401);
    response.end('{}');
  });
  const result = await querySubscriptionBySession(token, {
    page: f.page,
    browserContext: f.context,
    queryTransportMode: 'transport_compare'
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'SESSION_INVALID');
  assert.equal(result.compareDiagnostics[0].skippedReason, 'shared_context');
  assert.equal(f.seen.accountRequests.length, 1);
  assert.equal(f.page.isClosed(), false);
  noPayment(f.seen);
});

test('a same-context original-request comparison success cannot authorize a failed primary read', async (t) => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(401);
    response.end('{}');
  });
  let comparisons = 0,
    contexts = 0,
    logins = 0,
    cleaned = 0;
  f.context.request.get = async (url, options) => {
    comparisons++;
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.maxRedirects, 0);
    assert.ok(options.timeout <= 20000);
    return { status: () => 200, text: async () => JSON.stringify(accountBody) };
  };
  const query = ownedQuery(f, {
    onLogin: () => logins++,
    onContext: () => contexts++,
    onCleanup: () => cleaned++
  });
  const result = await query(token, {
    sessionRaw: 'synthetic-isolated-session',
    allowBrowserFallback: true,
    queryTransportMode: 'transport_compare'
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'SESSION_INVALID');
  assert.equal(result.compareDiagnostics.length, 1);
  assert.equal(result.compareDiagnostics[0].transport, 'context-request-compare');
  assert.equal(result.compareDiagnostics[0].httpStatus, 200);
  assert.equal(result.compareDiagnostics[0].accountFactsPresent, true);
  assert.equal(result.compareDiagnostics[0].accountIdentityMatches, true);
  assert.equal(comparisons, 1);
  assert.equal(contexts, 1);
  assert.equal(logins, 1);
  assert.equal(cleaned, 1);
  assert.equal(f.seen.accountRequests.length, 1);
  noPayment(f.seen);
});

test('a real Chromium evaluate queued past its deadline never dispatches a late GET', async (t) => {
  const f = await fixture(t, () => assert.fail('Expired queued read must not reach the listener'));
  let started;
  const busyStarted = new Promise((resolve) => {
    started = resolve;
  });
  await f.page.exposeBinding('syntheticNotifyBusy', () => started());
  const busy = f.page.evaluate(() => {
    void globalThis.syntheticNotifyBusy();
    const until = performance.now() + 350;
    while (performance.now() < until) {
      // Deliberately hold this isolated page's main thread, not the test process.
    }
  });
  await busyStarted;
  const result = await queryWithoutUnrelatedProbe()(token, {
    page: f.page,
    browserContext: f.context,
    deadlineAt: performance.now() + 100
  });
  await busy;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NETWORK_TIMEOUT');
  assert.equal(result.diagnostics[0].requestIssued, false);
  assert.equal(result.diagnostics[0].failurePhase, 'request_dispatch');
  assert.equal(result.diagnostics[0].timeoutSource, 'query_deadline');
  assert.equal(f.seen.originalRequests.length, 0);
  assert.equal(f.seen.accountRequests.length, 0);
  assert.equal(f.page.isClosed(), false);
  noPayment(f.seen);
});

test('a real Chromium evaluate queued before lease loss never dispatches a late GET', async (t) => {
  const f = await fixture(t, () => assert.fail('A lost-lease read must not reach the listener'));
  const sibling = await f.context.newPage();
  const lease = new AbortController();
  let started;
  const busyStarted = new Promise((resolve) => {
    started = resolve;
  });
  await f.page.exposeBinding('syntheticNotifyLeaseBusy', () => started());
  const busy = f.page.evaluate(() => {
    void globalThis.syntheticNotifyLeaseBusy();
    const until = performance.now() + 450;
    while (performance.now() < until) {
      // The cancellation must not wait for this task page's renderer thread.
    }
  });
  // A hard-closed page rejects its outstanding evaluation; observe that
  // rejection before deliberately closing it through lease cancellation.
  const busySettled = busy.then(
    () => {},
    () => {}
  );
  await busyStarted;
  const pending = queryWithoutUnrelatedProbe()(token, {
    page: f.page,
    browserContext: f.context,
    signal: lease.signal,
    deadlineAt: performance.now() + 1800
  });
  const rejected = assert.rejects(pending, { code: 'LEASE_LOST' });
  await delay(80);
  lease.abort();
  await rejected;
  await busySettled;
  await delay(100);
  assert.equal(
    f.seen.originalRequests.length,
    0,
    'No GET may dispatch after the queued read loses its lease'
  );
  assert.equal(f.seen.accountRequests.length, 0);
  assert.equal(f.page.isClosed(), true);
  assert.equal(sibling.isClosed(), false, 'Other pages in the browser context remain open');
  assert.equal(await sibling.evaluate(() => 1), 1);
  assert.equal(browser.isConnected(), true, 'The shared browser remains available');
  noPayment(f.seen);
});

test('a complete Chromium response remains valid when headers and body together need more than ten seconds', async (t) => {
  const f = await fixture(t, (_request, response, _record, later) => {
    later(8650, () => {
      response.writeHead(200);
      response.flushHeaders();
      later(3000, () => response.end(JSON.stringify(accountBody)));
    });
  });
  const result = await querySubscriptionBySession(token, {
    page: f.page,
    browserContext: f.context
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.length, 1);
  const observation = result.diagnostics[0];
  assert.equal(observation.httpStatus, 200);
  assert.equal(observation.responseBodyCompleted, true);
  assert.ok(observation.elapsedMs > 10000 && observation.elapsedMs < 20000);
  assert.ok(observation.headersElapsedMs >= 8000);
  assert.ok(observation.bodyElapsedMs >= 2500);
  assert.equal(f.seen.accountRequests.length, 1);
  noPayment(f.seen);
});

test('exclusive diagnostic queries perform one primary GET then one comparison after a transient failure', async (t) => {
  const f = await fixture(t, () => assert.fail('The intercepted reset cannot reach the listener'), {
    routeError: 'connectionreset'
  });
  let comparisons = 0;
  f.context.request.get = async () => {
    comparisons++;
    return { status: () => 200, text: async () => JSON.stringify(accountBody) };
  };
  const result = await ownedQuery(f)(token, {
    sessionRaw: 'synthetic-isolated-session',
    allowBrowserFallback: true,
    queryTransportMode: 'transport_compare'
  });
  assert.equal(result.ok, false, 'A comparison must not authorize the failed primary read');
  assert.equal(result.diagnostics.length, 1);
  assert.equal(f.seen.originalRequests.length, 1);
  assert.equal(comparisons, 1);
  assert.equal(result.compareDiagnostics[0].accountIdentityMatches, true);
  noPayment(f.seen);
});

test('a supplied context retains its transient retry even when comparison is requested', async (t) => {
  const f = await fixture(t, () => assert.fail('The intercepted reset cannot reach the listener'), {
    routeError: 'connectionreset'
  });
  const result = await queryWithoutUnrelatedProbe()(token, {
    page: f.page,
    browserContext: f.context,
    queryTransportMode: 'transport_compare'
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(f.seen.originalRequests.length, 2);
  assert.equal(result.compareDiagnostics[0].skippedReason, 'shared_context');
  assert.equal(f.page.isClosed(), false);
  noPayment(f.seen);
});

test('a shorter caller deadline is not extended to start an incomplete comparison', async (t) => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(accountBody)));
  const result = await ownedQuery(f)(token, {
    sessionRaw: 'synthetic-isolated-session',
    allowBrowserFallback: true,
    queryTransportMode: 'transport_compare',
    deadlineAt: performance.now() + 10000
  });
  assert.equal(result.ok, true);
  assert.equal(result.compareDiagnostics[0].skippedReason, 'deadline_exhausted');
  assert.equal(f.seen.accountRequests.length, 1);
  noPayment(f.seen);
});
