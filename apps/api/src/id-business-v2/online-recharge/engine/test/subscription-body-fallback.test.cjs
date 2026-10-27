'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { chromium } = require('../upstream/node_modules/playwright');
const { querySubscriptionBySession } = require('../upstream/subscription-check');
const { preflightPayment, confirmSubscription } = require('../confirmation.cjs');

const account = 'synthetic-fallback-account';
const token = `synthetic.${Buffer.from(
  JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: account }
  })
).toString('base64url')}.synthetic`;
const body = {
  accounts: {
    default: {
      account: { account_id: account },
      entitlement: { has_active_subscription: false, subscription_plan: 'free' }
    }
  }
};
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  format: 'pem',
  type: 'pkcs8'
});
const cert = execFileSync(
  '/bin/sh',
  ['-c', 'cat | openssl req -new -x509 -key /dev/stdin -sha256 -days 1 -subj /CN=chatgpt.com'],
  { input: key, timeout: 5000 }
);
let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
});

// The browser and context.request both use this real CONNECT proxy. It forwards
// only the official hostname to a loopback TLS fixture; no external request is sent.
async function fixture(t, handle) {
  const seen = { queries: [], mutations: 0, closed: 0, proxyConnections: 0, finished: 0 };
  const sockets = new Set(),
    timers = new Set();
  const later = (ms, action) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, ms);
    timers.add(timer);
  };
  const server = https.createServer({ key, cert }, (request, response) => {
    if (request.method !== 'GET') seen.mutations++;
    if (request.url.startsWith('/backend-api/accounts/check/')) {
      const record = {
        cookie: request.headers.cookie,
        bearer: request.headers.authorization,
        userAgent: request.headers['user-agent'],
        method: request.method,
        closed: false,
        finished: false
      };
      seen.queries.push(record);
      response.setHeader('content-type', 'application/json');
      response.on('close', () => {
        record.closed = true;
        seen.closed++;
      });
      response.on('finish', () => {
        record.finished = true;
        seen.finished++;
      });
      return handle(request, response, seen.queries.length, later, record);
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><html><body>Isolated authenticated query fixture</body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const proxy = http.createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  proxy.on('connect', (request, client, head) => {
    sockets.add(client);
    client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
    if (request.url !== 'chatgpt.com:443') return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    seen.proxyConnections++;
    const upstream = net.connect(server.address().port, '127.0.0.1');
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.once('close', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Synthetic-Fallback-Browser',
    proxy: { server: `http://127.0.0.1:${proxy.address().port}` }
  });
  await context.addCookies([
    {
      name: 'synthetic-session',
      value: 'synthetic-cookie',
      domain: 'chatgpt.com',
      path: '/',
      secure: true,
      httpOnly: true
    }
  ]);
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/');
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await context.close();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => proxy.close(r))]);
  });
  const query = (overrides = {}) =>
    querySubscriptionBySession(token, {
      page,
      browserContext: context,
      allowBodyReadFallback: true,
      ...overrides
    });
  return { query, page, context, seen };
}
function noMutation(seen) {
  assert.equal(seen.mutations, 0);
  assert.ok(seen.queries.length <= 2);
  assert.ok(seen.proxyConnections > 0);
  for (const q of seen.queries) {
    assert.equal(q.method, 'GET');
    assert.equal(q.bearer, `Bearer ${token}`);
    assert.match(q.cookie, /synthetic-session=synthetic-cookie/);
    assert.equal(q.userAgent, 'Synthetic-Fallback-Browser');
  }
}
function breakBody(_request, response, n, later) {
  if (n > 1) return response.end(JSON.stringify(body));
  response.write('{"accounts":');
  later(50, () => response.destroy());
}

test('normal complete body uses one browser GET without alternate transport', async (t) => {
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify(body)));
  const result = await f.query();
  assert.equal(result.ok, true);
  assert.equal(f.seen.queries.length, 1);
  assert.equal(result.diagnostics[0].transport, 'browser-page');
  noMutation(f.seen);
});
test('incomplete JSON body replaces second page attempt with same-context GET and preserves the page', async (t) => {
  const f = await fixture(t, breakBody);
  const result = await f.query();
  assert.equal(result.ok, true);
  assert.equal(f.seen.queries.length, 2);
  assert.equal(f.seen.queries[0].closed, true);
  assert.equal(f.seen.queries[0].finished, false);
  assert.deepEqual(
    result.diagnostics.map((r) => r.transport),
    ['browser-page', 'context-request-fallback']
  );
  assert.equal(result.diagnostics[0].failurePhase, 'response_body');
  assert.equal(result.diagnostics[1].responseBodyCompleted, true);
  assert.equal(f.page.isClosed(), false);
  noMutation(f.seen);
});
test('the normal preflight entry can accept only the complete matching fallback response', async (t) => {
  const f = await fixture(t, breakBody);
  const result = await preflightPayment('plus', token, { page: f.page, browserContext: f.context });
  assert.equal(result.allowed, true);
  assert.equal(f.seen.queries.length, 2);
  assert.equal(result.confirmation.queryDiagnostics[1].transport, 'context-request-fallback');
  noMutation(f.seen);
});
test('ordinary read-only callers retain their page retry without opting into context cancellation', async (t) => {
  const f = await fixture(t, breakBody);
  const result = await f.query({ allowBodyReadFallback: false });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.diagnostics.map((r) => r.transport),
    ['browser-page', 'browser-page']
  );
  noMutation(f.seen);
});
test('stalled body is cancelled at the original 20s limit before the single fallback GET', async (t) => {
  const f = await fixture(t, (_req, res, n) => {
    if (n === 1) {
      res.write('{"accounts":');
      return;
    }
    res.end(JSON.stringify(body));
  });
  const started = performance.now(),
    result = await f.query();
  assert.equal(result.ok, true);
  assert.ok(performance.now() - started < 26000);
  assert.equal(f.seen.queries.length, 2);
  assert.equal(f.seen.queries[0].closed, true);
  assert.equal(result.diagnostics[0].cancellationConfirmed, true);
  noMutation(f.seen);
});
for (const status of [401, 403])
  test(`HTTP ${status} never enters the body fallback`, async (t) => {
    const f = await fixture(t, (_req, res) => {
      res.statusCode = status;
      res.end('{"error":{"code":"invalid_session"}}');
    });
    const result = await f.query();
    assert.equal(result.ok, false);
    assert.equal(f.seen.queries.length, 1);
    noMutation(f.seen);
  });
test('explicit challenge headers stop an incomplete body without fallback or retry', async (t) => {
  const f = await fixture(t, (req, res, n, later) => {
    res.setHeader('cf-mitigated', 'challenge');
    breakBody(req, res, n, later);
  });
  const result = await f.query();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CHALLENGE_BLOCKED');
  assert.equal(f.seen.queries.length, 1);
  noMutation(f.seen);
});
for (const status of [401, 403])
  test(`incomplete HTTP ${status} body stops without fallback or a second GET`, async (t) => {
    const f = await fixture(t, (request, response, n, later) => {
      response.statusCode = status;
      breakBody(request, response, n, later);
    });
    const result = await f.query();
    assert.equal(result.ok, false);
    assert.equal(f.seen.queries.length, 1);
    assert.equal(result.diagnostics[0].httpStatus, status);
    assert.equal(result.diagnostics[0].responseBodyCompleted, false);
    assert.equal(result.diagnostics[0].transport, 'browser-page');
    noMutation(f.seen);
  });
test('a shorter caller deadline cannot start a fallback after exhausting the remaining budget', async (t) => {
  const f = await fixture(t, (_req, res) => res.write('{"accounts":'));
  const result = await f.query({ deadlineAt: performance.now() + 250 });
  assert.equal(result.ok, false);
  assert.equal(f.seen.queries.length, 1);
  assert.equal(result.errorCode, 'NETWORK_TIMEOUT');
  noMutation(f.seen);
});
for (const [name, text, error] of [
  ['invalid JSON', 'not-json', 'UPSTREAM_INVALID_RESPONSE'],
  ['missing facts', '{}', 'UPSTREAM_INVALID_RESPONSE'],
  [
    'different account',
    JSON.stringify({
      accounts: {
        default: {
          account: { account_id: 'other' },
          entitlement: { has_active_subscription: false }
        }
      }
    }),
    'ACCOUNT_MISMATCH'
  ]
])
  test(`fallback ${name} cannot authorize the preflight`, async (t) => {
    const f = await fixture(t, (req, res, n, later) => {
      if (n === 1) return breakBody(req, res, n, later);
      res.end(text);
    });
    const result = await f.query();
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, error);
    assert.equal(f.seen.queries.length, 2);
    noMutation(f.seen);
  });
test('challenge in the fallback ends the query without another browser GET or solver', async (t) => {
  const f = await fixture(t, (req, res, n, later) => {
    if (n === 1) return breakBody(req, res, n, later);
    res.statusCode = 403;
    res.setHeader('cf-mitigated', 'challenge');
    res.end('{}');
  });
  const result = await f.query();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CHALLENGE_BLOCKED');
  assert.equal(f.seen.queries.length, 2);
  noMutation(f.seen);
});
test('fallback deadline closes the owned context and leaves no third or pending request', async (t) => {
  const f = await fixture(t, (req, res, n, later) => {
    if (n === 1) return breakBody(req, res, n, later);
    res.write('{"accounts":');
  });
  const result = await f.query({ deadlineAt: performance.now() + 1200 });
  assert.equal(result.ok, false);
  assert.equal(f.page.isClosed(), true);
  assert.equal(result.diagnostics.at(-1).transport, 'context-request-fallback');
  assert.equal(result.diagnostics.at(-1).failurePhase, 'request_complete');
  assert.equal(result.diagnostics.at(-1).cancellationConfirmed, true);
  assert.equal(f.seen.queries.length, 2);
  assert.equal(f.seen.queries[1].closed, true);
  noMutation(f.seen);
});
test('lease loss during fallback stops the underlying GET and closes the owned page', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (req, res, n, later) => {
    if (n === 1) return breakBody(req, res, n, later);
    res.write('{"accounts":');
    later(50, () => controller.abort());
  });
  await assert.rejects(f.query({ signal: controller.signal }), (e) => e.code === 'LEASE_LOST');
  assert.equal(f.page.isClosed(), true);
  assert.equal(f.seen.queries.length, 2);
  noMutation(f.seen);
});
test('preflight alone enables fallback; ordinary confirmation keeps its existing transport', async () => {
  const seen = [];
  const query = async (_token, options) => {
    seen.push(options);
    return {
      ok: true,
      data: { hasActiveSubscription: false, upstreamAccountId: account, rawPlan: 'free' }
    };
  };
  await preflightPayment('plus', token, { query });
  await confirmSubscription('plus', token, { query });
  assert.equal(seen[0].allowBodyReadFallback, true);
  assert.equal(seen[1].allowBodyReadFallback, undefined);
});
