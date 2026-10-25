'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { format } = require('node:util');
const { performance } = require('node:perf_hooks');
const { runInNewContext } = require('node:vm');

const upstreamDirectory = path.join(__dirname, '../upstream');
const source = fs.readFileSync(path.join(upstreamDirectory, 'index.js'), 'utf8');
const stop = { allowed: false, errorCode: 'SIMULATED_PREFLIGHT_STOP' };

// Execute the complete production run() with a closed dependency surface.
// No real browser, network, database, account, checkout or payment is available.
function fixture(
  outcomes,
  { debugOnly = false, withoutProxy = false, signal, installFailure } = {}
) {
  const controller = new AbortController();
  const activeSignal = signal || controller.signal;
  const counts = {
    proxyPreparations: 0,
    browsers: 0,
    contexts: 0,
    sessionInstalls: 0,
    probes: 0,
    pages: 0,
    bootstraps: 0,
    preflights: 0,
    checkouts: 0,
    payments: 0,
    mediaFinishes: 0,
    contextCloses: 0,
    browserCloses: 0,
    proxyCleanups: 0
  };
  const requests = [];
  const logs = [];
  const proxy = withoutProxy ? undefined : { server: 'http://proxy.example.invalid:8123' };
  const page = { on() {}, isClosed: () => false };
  const context = {
    request: {
      async get(url, options) {
        requests.push({ owner: this, url, options });
        const attempt = ++counts.probes;
        assert.ok(attempt <= 5, 'Unexpected sixth proxy connection');
        let outcome = outcomes[attempt - 1];
        assert.notEqual(outcome, undefined, 'Unexpected extra proxy connection');
        if (typeof outcome === 'function') outcome = await outcome(controller);
        if (outcome instanceof Error) throw outcome;
        const status = typeof outcome === 'number' ? outcome : outcome.status;
        return {
          ok: () => status >= 200 && status < 300,
          status: () => status,
          async text() {
            if (outcome.bodyError) throw outcome.bodyError;
            outcome.beforeBody?.(controller);
            return '203.0.113.25';
          }
        };
      }
    },
    addInitScript: async () => {},
    pages: () => (counts.pages ? [page] : []),
    async newPage() {
      counts.pages++;
      return page;
    },
    async close() {
      counts.contextCloses++;
    }
  };
  const browser = {
    async newContext(options) {
      counts.contexts++;
      assert.equal(options.proxy, proxy);
      return context;
    }
  };
  const unavailable = (counter) => async () => {
    counts[counter]++;
    throw new Error('Business write must not run in the proxy simulation');
  };
  const modules = {
    './payment-retry': { executePaymentWithRetry: unavailable('payments') },
    './pricing-checkout': { openPricingCheckout: unavailable('checkouts') },
    './chatgpt': { openApiCheckout: unavailable('checkouts') },
    './mysql-store': { getPaymentRegion: async () => 'PH' },
    './region-config': {
      getRegionConfig: () => ({ currency: 'PHP' }),
      getRegionBrowserProfile: () => ({ locale: 'en-PH', timezoneId: 'Asia/Manila' })
    },
    './session-auth': {
      async installChatGptSession(receivedContext) {
        assert.equal(receivedContext, context);
        counts.sessionInstalls++;
        if (installFailure) throw installFailure;
        return { sessionData: {}, cookieVerified: true };
      },
      safeBootstrapDiagnostics: require('../upstream/session-auth').safeBootstrapDiagnostics,
      async bootstrapChatGptSession(receivedPage) {
        assert.equal(receivedPage, page);
        counts.bootstraps++;
        return { session: {} };
      }
    },
    './subscription-check': { cancelAutoRenew: unavailable('payments') },
    './browser-runtime': {
      async connectTaskBrowser(options) {
        assert.equal(options.proxyConfig, proxy);
        counts.browsers++;
        return { browser, realUserAgent: 'Synthetic Chrome/147.0' };
      },
      applyCdpEnv() {},
      async closeTaskBrowser() {
        counts.browserCloses++;
      }
    },
    './playwright-proxy': {
      async preparePlaywrightProxy() {
        counts.proxyPreparations++;
        return {
          proxyConfig: proxy,
          async cleanup() {
            counts.proxyCleanups++;
          }
        };
      }
    },
    '../safe-media.cjs': {
      start: async () => {},
      attach() {},
      screenshot: async () => null,
      async finish() {
        counts.mediaFinishes++;
        return [];
      }
    },
    '../rpc.cjs': {
      wasSubmitted: () => false,
      wasPaymentConfirmed: () => false,
      taskSignal: () => activeSignal
    },
    './human-verification': { prepareVerificationPage: async () => {} },
    '../human-verification.cjs': {},
    '../subscription-diagnostics.cjs': { observeAuthResponses: () => ({ dispose() {} }) },
    '../confirmation.cjs': {
      async preflightPayment(_plan, _token, options) {
        assert.equal(options.page, page);
        assert.equal(options.browserContext, context);
        assert.equal(options.allowUnverifiedTarget, debugOnly);
        counts.preflights++;
        return stop;
      }
    },
    '../checkout-await-diagnostics.cjs': { LABELS: {} },
    fs,
    path
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    __dirname: upstreamDirectory,
    performance,
    process: {
      env: {
        CDK_PLAN_TYPE: 'pro_20x',
        CHECKOUT_DEBUG_ONLY: debugOnly ? '1' : '0',
        PROXY: withoutProxy ? '' : proxy.server,
        RECORD_VIDEO: '0'
      }
    },
    console: Object.fromEntries(
      ['log', 'warn', 'error'].map((level) => [level, (...args) => logs.push(format(...args))])
    ),
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `Unmocked executor dependency: ${name}`);
      return modules[name];
    }
  });
  return { run: module.exports.run, counts, requests, logs, controller, context };
}

test('an initial Session failure returns its classification and cleans up the original task resources', async () => {
  const f = fixture([], {
    installFailure: Object.assign(new Error('synthetic invalid Session'), {
      code: 'SESSION_INVALID',
      bootstrapDiagnostics: { initialSessionProbe: { state: 'invalid', httpStatus: 401 } }
    })
  });
  const result = await f.run();
  assert.equal(result.errorCode, 'SESSION_INVALID');
  assert.equal(result.bootstrapDiagnostics.initialSessionProbe.state, 'invalid');
  for (const key of ['contextCloses', 'browserCloses', 'proxyCleanups'])
    assert.equal(f.counts[key], 1, key);
  for (const key of ['probes', 'bootstraps', 'preflights', 'checkouts', 'payments'])
    assert.equal(f.counts[key], 0, key);
});

function assertLifecycle(f, expectedProbes, continued) {
  assert.equal(f.counts.probes, expectedProbes);
  for (const key of [
    'proxyPreparations',
    'browsers',
    'contexts',
    'sessionInstalls',
    'mediaFinishes',
    'contextCloses',
    'browserCloses',
    'proxyCleanups'
  ])
    assert.equal(f.counts[key], 1, `${key} must occur exactly once`);
  for (const key of ['pages', 'bootstraps', 'preflights'])
    assert.equal(f.counts[key], continued ? 1 : 0, key);
  assert.equal(f.counts.checkouts, 0);
  assert.equal(f.counts.payments, 0);
  for (const [index, request] of f.requests.entries()) {
    assert.equal(request.owner, f.context.request, 'Task request context must stay the same');
    assert.equal(request.url, 'http://api.ipify.org/?format=text');
    assert.equal(request.options.timeout, 15000);
    assert.ok(
      f.logs.some((line) => line.includes(`正在检查代理连通性...（第 ${index + 1}/5 次）`))
    );
  }
}

for (const debugOnly of [false, true]) {
  const mode = debugOnly ? 'debug' : 'recharge';
  for (const successAt of [1, 2, 5]) {
    test(`${mode}: connection ${successAt} succeeds and continuation runs once`, async () => {
      const f = fixture(
        [...Array.from({ length: successAt - 1 }, () => new Error('socket hang up')), 200],
        { debugOnly }
      );
      const result = await f.run();
      assert.equal(result.errorCode, stop.errorCode);
      assertLifecycle(f, successAt, true);
      assert.equal(f.logs.filter((line) => line.includes('次失败：')).length, successAt - 1);
      assert.equal(f.logs.filter((line) => line.includes('代理连接成功!')).length, 1);
      assert.ok(
        f.logs.some(
          (line) => line.includes(`代理连接成功!`) && line.includes(`第 ${successAt}/5 次`)
        )
      );
    });
  }

  test(`${mode}: five socket failures stop before login and expose a controlled result`, async () => {
    const f = fixture(
      Array.from({ length: 5 }, () => new Error('socket hang up')),
      { debugOnly }
    );
    const result = await f.run();
    assertLifecycle(f, 5, false);
    assert.equal(result.success, false);
    assert.equal(result.resultUnknown, false);
    assert.equal(result.errorCode, 'PROXY_UNAVAILABLE');
    assert.match(result.error, /已用尽 5 次/);
    assert.equal(f.logs.filter((line) => line.includes('次失败：')).length, 5);
    assert.equal(f.logs.filter((line) => line.includes('继续下一次连接')).length, 4);
    assert.equal(f.logs.filter((line) => line.includes('已达尝试上限')).length, 1);
  });
}

for (const [failure, expectedReason] of [
  [new Error('socket hang up'), '连接被关闭或重置'],
  [new Error('ECONNRESET'), '连接被关闭或重置'],
  [new Error('Timeout 15000ms exceeded'), '连接超时'],
  [new Error('ENOTFOUND example.invalid'), '域名解析失败'],
  [new Error('ECONNREFUSED'), '连接被拒绝'],
  [new Error('ERR_PROXY_CONNECTION_FAILED'), '代理认证或隧道连接失败'],
  [new Error('certificate validation failed'), 'TLS 或证书连接失败'],
  [new Error('unrecognized transport failure'), '网络请求未完成'],
  [407, 'HTTP 407'],
  [503, 'HTTP 503']
]) {
  test(`failure classification: ${expectedReason}`, async () => {
    const f = fixture([failure, 200]);
    await f.run();
    assertLifecycle(f, 2, true);
    assert.ok(f.logs.some((line) => line.includes(`第 1/5 次失败：${expectedReason}`)));
  });
}

test('five simulated timeouts retain the original per-attempt 15 second budget', async () => {
  let simulatedElapsedMs = 0;
  const f = fixture(
    Array.from({ length: 5 }, () => () => {
      simulatedElapsedMs += 15000;
      return new Error('Timeout 15000ms exceeded');
    })
  );
  await f.run();
  assertLifecycle(f, 5, false);
  assert.equal(simulatedElapsedMs, 75000);
});

test('a failed response-body read consumes one attempt and can recover', async () => {
  const f = fixture([{ status: 200, bodyError: new Error('socket hang up') }, 200]);
  await f.run();
  assertLifecycle(f, 2, true);
});

test('cancellation before the probe sends no connection', async () => {
  const controller = new AbortController();
  const reason = new Error('Synthetic cancellation');
  controller.abort(reason);
  const f = fixture([], { signal: controller.signal });
  await assert.rejects(f.run, (error) => error === reason);
  assertLifecycle(f, 0, false);
});

test('cancellation during a failed probe prevents the second connection', async () => {
  const error = new Error('socket hang up');
  const f = fixture([
    (controller) => {
      controller.abort(new Error('Synthetic cancellation'));
      return error;
    }
  ]);
  await assert.rejects(f.run, (received) => received === error);
  assertLifecycle(f, 1, false);
});

test('lease loss prevents the second connection and retains its reason', async () => {
  const error = Object.assign(new Error('Synthetic lease loss'), { code: 'LEASE_LOST' });
  const f = fixture([error]);
  await assert.rejects(f.run, (received) => received === error);
  assertLifecycle(f, 1, false);
});

test('cancellation after response-body read does not log success or continue', async () => {
  const reason = new Error('Synthetic cancellation');
  const f = fixture([{ status: 200, beforeBody: (controller) => controller.abort(reason) }]);
  await assert.rejects(f.run, (received) => received === reason);
  assertLifecycle(f, 1, false);
  assert.equal(
    f.logs.some((line) => line.includes('代理连接成功!')),
    false
  );
});

test('attempt logs do not forward raw request or credential text', async () => {
  const marker = 'SYNTHETIC_PRIVATE_MARKER';
  const f = fixture([
    new Error(`socket hang up\nCookie: ${marker}\nAuthorization: ${marker}`),
    200
  ]);
  await f.run();
  assertLifecycle(f, 2, true);
  assert.equal(f.logs.join('\n').includes(marker), false);
});

test('without an assigned proxy, existing continuation is unchanged and no probe is sent', async () => {
  const f = fixture([], { withoutProxy: true });
  await f.run();
  assertLifecycle(f, 0, true);
  assert.equal(
    f.logs.some((line) => line.includes('正在检查代理连通性')),
    false
  );
});
