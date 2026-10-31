'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runProxyClientDiagnostic } = require('../proxy-client-diagnostic.cjs');
const secret = 'synthetic-proxy-password';
const echo = 'https://api.ipify.org/?format=text';
const proxyConfig = {
  server: 'http://synthetic.example.invalid:8080',
  username: 'synthetic-user',
  password: secret
};
function fixture({ exits = [], navigationFailure, apiFailure, fetchFailure } = {}) {
  let handler,
    connected = true,
    index = 0,
    closed = 0;
  const methods = [],
    calls = [],
    launchOptions = [];
  const result = () => {
    const value = exits[index++] || '198.51.100.4';
    return typeof value === 'string' ? { status: 200, text: value } : value;
  };
  const issue = async (navigation) => {
    let allowed = false;
    await handler({
      request: () => ({
        url: () => echo,
        method: () => 'GET',
        isNavigationRequest: () => navigation,
        resourceType: () => (navigation ? 'document' : 'fetch'),
        redirectedFrom: () => null
      }),
      continue: async () => {
        allowed = true;
      },
      abort: async () => {}
    });
    assert.equal(allowed, true);
  };
  const response = (r) => ({
    status: () => r.status,
    text: async () => r.text,
    dispose: async () => {}
  });
  const page = {
    url: () => echo,
    goto: async (url) => {
      calls.push(['navigation', url]);
      await issue(true);
      if (navigationFailure) throw navigationFailure;
      return response(result());
    },
    evaluate: async (_fn, arg) => {
      calls.push(['same_origin_fetch', arg.url]);
      await issue(false);
      if (fetchFailure) throw fetchFailure;
      return result();
    }
  };
  const context = {
    newPage: async () => page,
    route: async (_pattern, callback) => {
      handler = callback;
    },
    close: async () => {
      closed++;
    },
    request: {
      get: async (url, options) => {
        calls.push(['context_request', url]);
        assert.equal(options.maxRetries, 0);
        assert.equal(options.maxRedirects, 0);
        if (apiFailure) throw apiFailure;
        return response(result());
      }
    },
    addCookies: () => {
      methods.push('addCookies');
      throw Error('NO_CREDENTIALS');
    }
  };
  const browser = {
    newContext: async (options) => {
      assert.equal(options.proxy, proxyConfig);
      return context;
    },
    close: async () => {
      connected = false;
    },
    isConnected: () => connected
  };
  return {
    chromium: {
      launch: async (options) => {
        launchOptions.push(options);
        return browser;
      }
    },
    browser,
    context,
    calls,
    methods,
    launchOptions,
    closed: () => closed,
    handler: () => handler
  };
}
test('fixed five-sample order compares three clients with a fresh context and returns only hashes', async () => {
  const f = fixture();
  const r = await runProxyClientDiagnostic({ proxyConfig, chromium: f.chromium });
  assert.equal(r.outcome, 'observations_match');
  assert.equal(r.requestsIssued, 5);
  assert.equal(r.maximumDurationMs, 90000);
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ['navigation', 'context_request', 'same_origin_fetch', 'context_request', 'same_origin_fetch']
  );
  assert.ok(f.calls.every((x) => x[1] === echo));
  assert.equal(r.chatgptRequests, 0);
  assert.equal(r.cleanupConfirmed, true);
  assert.deepEqual(f.methods, []);
  assert.equal(f.launchOptions[0].proxy, proxyConfig);
  assert.equal(f.launchOptions[0].headless, true);
  assert.equal(r.conclusionScope, 'sampled_echo_service_window_only');
  assert.ok(!JSON.stringify(r).includes(secret));
  assert.ok(!JSON.stringify(r).includes('198.51.100.4'));
});
test('different observations are labelled without attributing them to a client or supplier', async () => {
  const f = fixture({
    exits: ['198.51.100.1', '198.51.100.2', '198.51.100.1', '198.51.100.1', '198.51.100.1']
  });
  const r = await runProxyClientDiagnostic({ proxyConfig, chromium: f.chromium });
  assert.equal(r.outcome, 'observations_differ');
  assert.equal(r.requestsIssued, 5);
  assert.equal(r.rootCause, undefined);
  assert.equal(r.exitDriftExcluded, undefined);
});
test('CSP/CORS/HTTP/non-IP failures remain incomplete and never retry', async () => {
  for (const [option, error, expected] of [
    ['fetchFailure', new Error('CSP connect-src ' + secret), 'csp'],
    ['fetchFailure', new Error('CORS ' + secret), 'cors'],
    ['apiFailure', new Error('ETIMEDOUT ' + secret), 'timeout']
  ]) {
    const f = fixture({ [option]: error });
    const r = await runProxyClientDiagnostic({ proxyConfig, chromium: f.chromium });
    assert.equal(r.outcome, 'diagnostic_incomplete');
    assert.ok(r.observations.some((x) => x.failureReason === expected));
    assert.equal(r.requestsIssued, 5);
    assert.ok(!JSON.stringify(r).includes(secret));
    assert.equal(r.cleanupConfirmed, true);
  }
  const f = fixture({ exits: ['invalid ' + secret] });
  const r = await runProxyClientDiagnostic({ proxyConfig, chromium: f.chromium });
  assert.equal(r.observations[0].failureReason, 'invalid_echo');
  assert.equal(r.outcome, 'diagnostic_incomplete');
  const denied = fixture({ exits: [{ status: 302, text: 'redirect ' + secret }] });
  const redirect = await runProxyClientDiagnostic({ proxyConfig, chromium: denied.chromium });
  assert.equal(redirect.observations[0].failureReason, 'http_status');
  assert.equal(denied.calls.length, 5);
  assert.ok(!JSON.stringify(redirect).includes(secret));
});
test('failed navigation never runs a fetch from about:blank or a login page', async () => {
  const f = fixture({ navigationFailure: new Error('network ' + secret) });
  const r = await runProxyClientDiagnostic({ proxyConfig, chromium: f.chromium });
  assert.deepEqual(
    f.calls.map((x) => x[0]),
    ['navigation', 'context_request', 'context_request']
  );
  assert.equal(r.requestsIssued, 3);
  assert.equal(
    r.observations.filter((x) => x.failureReason === 'same_origin_unavailable').length,
    2
  );
});
test('auxiliary requests, redirects, and requests after the five-sample window cannot reach the network', async () => {
  const f = fixture();
  const r = await runProxyClientDiagnostic({ proxyConfig, chromium: f.chromium });
  let continued = 0,
    denied = 0;
  for (const url of [
    echo,
    'https://api.ipify.org/favicon.ico',
    'https://chatgpt.com/api/auth/session'
  ]) {
    await f.handler()({
      request: () => ({
        url: () => url,
        method: () => 'GET',
        isNavigationRequest: () => true,
        redirectedFrom: () => null
      }),
      continue: async () => {
        continued++;
      },
      abort: async () => {
        denied++;
      }
    });
  }
  assert.equal(continued, 0);
  assert.equal(denied, 3);
  assert.equal(r.requestsIssued, 5);
});
test('pre-abort and invalid proxies launch no browser and cannot fall back to direct traffic', async () => {
  for (const options of [
    { proxyConfig: null },
    { proxyConfig: { ...proxyConfig, bypass: '*' } },
    { proxyConfig, signal: AbortSignal.abort() }
  ]) {
    const f = fixture();
    const r = await runProxyClientDiagnostic({ ...options, chromium: f.chromium });
    assert.equal(f.launchOptions.length, 0);
    assert.equal(r.requestsIssued, 0);
    assert.equal(r.outcome, 'diagnostic_incomplete');
  }
});
test('deadline closes owned resources; a late launch is closed and is not reported as confirmed cleanup', async () => {
  const f = fixture();
  let release;
  const r = await runProxyClientDiagnostic({
    proxyConfig,
    chromium: {
      launch: () =>
        new Promise((resolve) => {
          release = resolve;
        })
    },
    timeoutMs: 100
  });
  assert.equal(r.outcome, 'diagnostic_incomplete');
  assert.equal(r.failureReason, 'timeout');
  assert.equal(r.cleanupConfirmed, false);
  release(f.browser);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.browser.isConnected(), false);
});

test('abort during an API request ends sampling and closes its owned browser, without another client request', async () => {
  const f = fixture(),
    controller = new AbortController();
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  f.context.request.get = () => {
    began();
    return new Promise(() => {});
  };
  const pending = runProxyClientDiagnostic({
    proxyConfig,
    chromium: f.chromium,
    signal: controller.signal
  });
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.outcome, 'diagnostic_incomplete');
  assert.equal(result.requestsIssued, 2);
  assert.equal(result.observations.at(-1).failureReason, 'cancelled');
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(f.closed(), 1);
});

test('unconfirmed browser cleanup is explicit and never becomes a completed comparison', async () => {
  const f = fixture();
  f.browser.close = async () => {
    throw Error(secret);
  };
  const result = await runProxyClientDiagnostic({ proxyConfig, chromium: f.chromium });
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.outcome, 'diagnostic_incomplete');
  assert.ok(!JSON.stringify(result).includes(secret));
});
