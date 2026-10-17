'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../upstream/subscription-check.js'), 'utf8');
const accountId = 'synthetic-account';
const token = 'synthetic-access-for-mocked-transport';
function account(enabled, account = accountId) {
  return {
    accounts: {
      default: {
        account: { account_id: account },
        entitlement: { has_active_subscription: true, subscription_plan: 'plus' },
        last_active_subscription: { will_renew: enabled, purchase_origin_platform: 'web' }
      }
    }
  };
}
function fixture({ reads, postStatus = 200, postThrows = false, guardThrows = false }) {
  let submitted = false;
  let known = 0;
  const posts = [];
  const prepared = [];
  const response = (status, data) => ({ status: () => status, json: async () => data });
  const rpc = {
    beforeExternalSubmit: async (detail) => {
      prepared.push(detail);
      if (guardThrows) throw new Error('synthetic lease rejected');
      submitted = true;
    },
    wasSubmitted: () => submitted,
    recordKnownOutcome: () => {
      known++;
      submitted = false;
    }
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === 'axios')
        return {
          get: async () => {
            throw new Error('No secondary transport');
          }
        };
      if (name === 'playwright')
        return {
          request: {
            newContext: async () => ({
              get: async () => {
                const next = reads.shift();
                assert.ok(next, 'Unexpected additional readback');
                return response(next.status ?? 200, next.data);
              },
              fetch: async (url, options) => {
                assert.equal(options.method, 'POST');
                posts.push({ url, options });
                if (postThrows) throw new Error('Synthetic response lost');
                return response(postStatus, {});
              },
              dispose: async () => {}
            })
          }
        };
      if (name === './session-auth')
        return { extractProfileFromToken: () => ({ accountId, email: 'fixture@example.invalid' }) };
      if (name === './playwright-proxy')
        return { preparePlaywrightProxy: async () => ({ cleanup: async () => {} }) };
      if (name === '../rpc.cjs') return rpc;
      if (name === '../plans.cjs') return require('../plans.cjs');
      throw new Error(`Unexpected import: ${name}`);
    },
    process: { env: {} },
    Buffer,
    console,
    URL,
    Date
  });
  return { api: module.exports, posts, prepared, submitted: () => submitted, known: () => known };
}

for (const [action, method, enabled] of [
  ['disable', 'cancelAutoRenew', false],
  ['enable', 'resumeAutoRenew', true]
]) {
  test(`${action}: one guarded POST and matching account target readback confirms success`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }, { data: account(enabled) }] });
    const result = await f.api[method](token);
    assert.equal(result.ok, true);
    assert.equal(result.data.accountId, accountId);
    assert.equal(result.data.autoRenewRaw, enabled);
    assert.equal(f.posts.length, 1);
    assert.equal(f.prepared[0].renewalAction, action);
    assert.equal(f.submitted(), false);
    assert.equal(f.known(), 1);
  });

  test(`${action}: POST 200 with unchanged readback remains unknown and cannot retry`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }, { data: account(!enabled) }] });
    const result = await f.api[method](token);
    assert.equal(result.ok, false);
    assert.equal(result.resultUnknown, true);
    assert.equal(f.posts.length, 1);
    assert.equal(f.submitted(), true);
    assert.equal(f.known(), 0);
  });

  test(`${action}: readback from another account cannot confirm the mutation`, async () => {
    const f = fixture({
      reads: [{ data: account(!enabled) }, { data: account(enabled, 'other-account') }]
    });
    const result = await f.api[method](token);
    assert.equal(result.resultUnknown, true);
    assert.equal(f.submitted(), true);
    assert.equal(f.posts.length, 1);
  });

  test(`${action}: unreadable post-submit state remains unknown`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }, { status: 401, data: {} }] });
    const result = await f.api[method](token);
    assert.equal(result.resultUnknown, true);
    assert.equal(f.posts.length, 1);
    assert.equal(f.known(), 0);
  });

  test(`${action}: lost POST response never falls back to a second POST`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }], postThrows: true });
    const result = await f.api[method](token);
    assert.equal(result.resultUnknown, true);
    assert.equal(f.posts.length, 1);
    assert.equal(f.submitted(), true);
  });

  test(`${action}: initial account mismatch and already-target state submit nothing`, async () => {
    const mismatch = fixture({ reads: [{ data: account(!enabled, 'other-account') }] });
    assert.equal((await mismatch.api[method](token)).ok, false);
    assert.equal(mismatch.posts.length, 0);
    assert.equal(mismatch.prepared.length, 0);
    const already = fixture({ reads: [{ data: account(enabled) }] });
    assert.equal((await already.api[method](token)).ok, true);
    assert.equal(already.posts.length, 0);
    assert.equal(already.prepared.length, 0);
  });

  test(`${action}: lease rejection stops before any external POST`, async () => {
    const f = fixture({ reads: [{ data: account(!enabled) }], guardThrows: true });
    const result = await f.api[method](token);
    assert.equal(result.ok, false);
    assert.equal(Boolean(result.resultUnknown), false);
    assert.equal(f.posts.length, 0);
    assert.equal(f.submitted(), false);
  });

  for (const postStatus of [401, 403]) {
    test(`${action}: explicit ${postStatus} rejection is a known failure`, async () => {
      const f = fixture({ reads: [{ data: account(!enabled) }], postStatus });
      const result = await f.api[method](token);
      assert.equal(result.ok, false);
      assert.equal(result.definitiveFailure, true);
      assert.equal(result.renewalRejected, true);
      assert.equal(f.posts.length, 1);
      assert.equal(f.submitted(), false);
    });
  }
}

test('GET subscription query uses no external-submit guard', async () => {
  const f = fixture({ reads: [{ data: account(true) }] });
  assert.equal((await f.api.querySubscriptionBySession(token)).ok, true);
  assert.equal(f.posts.length, 0);
  assert.equal(f.prepared.length, 0);
});

// No real upstream or proxy connections: all transports and browser sessions are isolated fakes.
function queryFixture({
  statuses = [200],
  failure,
  failures = [],
  loginFailure,
  contextFailure,
  verificationResult,
  responseBody = account(true)
} = {}) {
  const effects = {
    proxies: [],
    requests: [],
    contexts: [],
    closes: 0,
    disposes: 0,
    cleanups: 0,
    logins: 0,
    browserConnections: [],
    pageCloses: 0,
    preparedPages: [],
    disposedPages: []
  };
  const browserContexts = [];
  const response = () => ({
    status: () => statuses.shift() ?? 403,
    json: async () => responseBody
  });
  const sessionAuth = {
    extractProfileFromToken: () => ({ accountId }),
    installChatGptSession: async (context, raw) => {
      context.installed = raw;
      return { sessionData: {} };
    },
    bootstrapChatGptSession: async (page, _raw, options) => {
      effects.logins++;
      assert.equal(typeof options.deadlineAt, 'number');
      assert.notEqual(options.manualVerification, true);
      if (loginFailure) throw loginFailure;
      await page.goto('https://chatgpt.com/');
      return { session: { accessToken: token } };
    }
  };
  const newBrowserContext = () => {
    const pages = [];
    const context = {
      pages: () => pages,
      request: {
        get: async (...args) => {
          effects.requests.push({ context, args });
          return response();
        }
      },
      newPage: async () => {
        let currentUrl = 'about:blank',
          closed = false;
        const page = {
          url: () => currentUrl,
          isClosed: () => closed,
          context: () => context,
          goto: async (url) => {
            currentUrl = url;
          },
          evaluate: async (fn, args) => {
            assert.match(String(fn), /method: 'GET'/);
            assert.match(String(fn), /credentials: 'include'/);
            assert.ok(args.timeoutMs <= 10000);
            effects.requests.push({ context, page, args, transport: 'browser-page' });
            const nextFailure = failures.shift() || failure;
            if (nextFailure) throw nextFailure;
            return { status: statuses.shift() ?? 403, text: JSON.stringify(responseBody) };
          },
          close: async () => {
            effects.pageCloses++;
            closed = true;
          },
          on: () => {},
          off: () => {}
        };
        pages.push(page);
        return page;
      },
      close: async () => {
        effects.closes++;
      }
    };
    browserContexts.push(context);
    return context;
  };
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    Buffer,
    URL,
    Date,
    console,
    process: { env: { PROXY: 'http://task-proxy.invalid:8123' } },
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === '../rpc.cjs') return {};
      if (name === './human-verification')
        return {
          prepareVerificationPage: async (page) => {
            effects.preparedPages.push(page);
          },
          disposeVerificationPage: async (page) => {
            effects.disposedPages.push(page);
          },
          isBlockingHumanVerificationVisible: async () => Boolean(verificationResult),
          clearHumanVerification: async () => verificationResult
        };
      if (name === 'playwright')
        return {
          request: {
            newContext: async (options) => {
              effects.contexts.push(options);
              if (contextFailure) throw contextFailure;
              return {
                get: async (...args) => {
                  effects.requests.push({ args });
                  if (failure) throw failure;
                  return response();
                },
                dispose: async () => {
                  effects.disposes++;
                }
              };
            }
          }
        };
      if (name === './session-auth') return sessionAuth;
      if (name === './playwright-proxy')
        return {
          preparePlaywrightProxy: async (proxy) => {
            effects.proxies.push(proxy);
            return {
              proxyConfig: { server: proxy },
              cleanup: async () => {
                effects.cleanups++;
              }
            };
          }
        };
      if (name === './browser-runtime')
        return {
          connectTaskBrowser: async (options) => {
            effects.browserConnections.push(options);
            return {
              browser: {
                newContext: async (options) => {
                  effects.contexts.push(options);
                  return newBrowserContext();
                }
              }
            };
          },
          closeTaskBrowser: async () => {}
        };
      if (name === '../plans.cjs') return require('../plans.cjs');
      throw new Error(`Unexpected transport ${name}`);
    }
  });
  return { api: module.exports, effects, newBrowserContext, browserContexts };
}

test('logged-in recharge reads through its existing Chromium page and never a Node request context', async () => {
  const f = queryFixture();
  const context = f.newBrowserContext();
  const page = await context.newPage();
  await page.goto('https://chatgpt.com/');
  const result = await f.api.querySubscriptionBySession(token, { browserContext: context, page });
  assert.equal(result.ok, true);
  assert.equal(f.effects.requests[0].context, context);
  assert.equal(f.effects.requests[0].transport, 'browser-page');
  assert.equal(f.effects.contexts.length, 0);
  assert.equal(f.effects.proxies.length, 0);
  assert.equal(f.effects.closes + f.effects.disposes + f.effects.pageCloses, 0);
});

test('independent query logs in once in an isolated browser using only the resolved task proxy', async () => {
  const f = queryFixture({ statuses: [200] });
  assert.equal(
    (
      await f.api.querySubscriptionBySession(token, {
        sessionRaw: 'synthetic-session-A',
        allowBrowserFallback: true
      })
    ).ok,
    true
  );
  assert.equal(f.effects.logins, 1);
  assert.equal(new Set(f.effects.proxies).size, 1);
  assert.equal(
    f.effects.contexts[0].proxy.server,
    f.effects.browserConnections[0].proxyConfig.server
  );
  assert.equal(f.browserContexts[0].installed, 'synthetic-session-A');
  assert.equal(f.effects.closes, 1);
  assert.equal(f.effects.disposes, 0);
  assert.equal(f.effects.cleanups, 1);
  assert.equal(f.effects.preparedPages[0], f.effects.requests[0].page);
  assert.equal(f.effects.disposedPages[0], f.effects.requests[0].page);
});

test('repeated 403 stops after one browser check and does not label the session expired', async () => {
  const f = queryFixture({ statuses: [403, 403] });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'synthetic',
    allowBrowserFallback: true
  });
  assert.equal(result.errorCode, 'UPSTREAM_FORBIDDEN');
  assert.equal(f.effects.requests.length, 1);
  assert.equal(f.effects.logins, 1);
  assert.equal(f.effects.closes, 1);
});

test('401 is login failure and never creates a fallback browser', async () => {
  const f = queryFixture({ statuses: [401] });
  assert.equal((await f.api.querySubscriptionBySession(token)).errorCode, 'SESSION_INVALID');
  assert.equal(f.effects.logins, 0);
});

for (const [message, networkCode, code] of [
  ['Timeout 20000ms exceeded synthetic-secret', 'ETIMEDOUT', 'NETWORK_TIMEOUT'],
  ['SOCKS proxy connection refused synthetic-secret', 'ECONNREFUSED', 'PROXY_UNAVAILABLE']
])
  test(`query classifies ${code} without exposing the raw transport error`, async () => {
    const f = queryFixture({ failure: Object.assign(new Error(message), { code: networkCode }) });
    const result = await f.api.querySubscriptionBySession(token);
    assert.equal(result.errorCode, code);
    assert.equal(JSON.stringify(result).includes(message), false);
    assert.equal(f.effects.disposes, 1);
  });

test('browser verification failure retains its actual controlled code and closes the isolated context', async () => {
  const f = queryFixture({
    statuses: [403],
    loginFailure: Object.assign(new Error('challenge'), { code: 'VERIFICATION_UNSUPPORTED' })
  });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'synthetic',
    allowBrowserFallback: true
  });
  assert.equal(result.errorCode, 'VERIFICATION_UNSUPPORTED');
  assert.equal(f.effects.closes, 1);
  assert.equal(f.effects.requests.length, 0);
});

test('sequential independent tasks get different contexts and never inherit previous cookies', async () => {
  const f = queryFixture({ statuses: [200, 200] });
  for (const sessionRaw of ['synthetic-A', 'synthetic-B'])
    assert.equal(
      (await f.api.querySubscriptionBySession(token, { sessionRaw, allowBrowserFallback: true }))
        .ok,
      true
    );
  assert.notEqual(f.browserContexts[0], f.browserContexts[1]);
  assert.deepEqual(
    f.browserContexts.map((c) => c.installed),
    ['synthetic-A', 'synthetic-B']
  );
  assert.equal(f.effects.closes, 2);
});

test('request context creation failure still cleans the proxy adapter', async () => {
  const f = queryFixture({ contextFailure: new Error('proxy context failure') });
  assert.equal((await f.api.querySubscriptionBySession(token)).ok, false);
  assert.equal(f.effects.cleanups, 1);
});

test('a transient GET reset retries only once on the same page and resolved proxy', async () => {
  const f = queryFixture({
    failures: [Object.assign(new Error('private headers must not escape'), { code: 'ECONNRESET' })]
  });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'fixture',
    allowBrowserFallback: true
  });
  assert.equal(result.ok, true);
  assert.equal(f.effects.requests.length, 2);
  assert.equal(f.effects.requests[0].page, f.effects.requests[1].page);
  assert.equal(f.effects.proxies.length, 1);
  assert.equal(result.diagnostics[0].networkCode, 'ECONNRESET');
  assert.equal(JSON.stringify(result).includes('private headers'), false);
});

test('failed GET attempts are bounded and never enter an alternate browser or proxy', async () => {
  const f = queryFixture({ failure: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'fixture',
    allowBrowserFallback: true
  });
  assert.equal(result.ok, false);
  assert.equal(f.effects.requests.length, 2);
  assert.equal(f.effects.logins, 1);
  assert.equal(f.effects.proxies.length, 1);
  assert.equal(result.diagnostics.length, 2);
});

test('a valid HTTP response without account facts is never a successful subscription query', async () => {
  const f = queryFixture({ responseBody: {} });
  const result = await f.api.querySubscriptionBySession(token);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UPSTREAM_INVALID_RESPONSE');
});

test('an aborted query stops before creating a context or making any request', async () => {
  const f = queryFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => f.api.querySubscriptionBySession(token, { signal: controller.signal }),
    { code: 'LEASE_LOST' }
  );
  assert.equal(f.effects.requests.length, 0);
  assert.equal(f.effects.contexts.length, 0);
});

test('real Chromium subscription GET shares only its own context cookies and bypasses APIRequestContext', async () => {
  const { chromium } = require('../upstream/node_modules/playwright');
  const api = require('../upstream/subscription-check');
  const browser = await chromium.launch({ headless: true });
  const contexts = [],
    seen = [];
  try {
    for (const id of ['first-account', 'second-account']) {
      const context = await browser.newContext();
      contexts.push(context);
      await context.addCookies([
        { name: 'fixture-session', value: id, domain: 'chatgpt.com', path: '/', secure: true }
      ]);
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (!request.url().startsWith('https://chatgpt.com/')) return route.abort();
        if (request.url().includes('/backend-api/accounts/check/')) {
          const cookie = request.headers().cookie || '';
          seen.push({ id, cookie, method: request.method() });
          return route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(account(true, id))
          });
        }
        return route.fulfill({
          contentType: 'text/html',
          body: '<html><body>Fixture homepage</body></html>'
        });
      });
      context.request.get = async () =>
        assert.fail('Query must use Chromium fetch, never Node HTTP');
      const page = await context.newPage();
      await page.goto('https://chatgpt.com/');
      const result = await api.querySubscriptionBySession(token, { page, browserContext: context });
      assert.equal(result.ok, true);
      assert.equal(result.data.upstreamAccountId, id);
      assert.equal(page.isClosed(), false);
    }
    assert.equal(seen.length, 2);
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[1].method, 'GET');
    assert.equal(seen[0].cookie.includes('first-account'), true);
    assert.equal(seen[0].cookie.includes('second-account'), false);
    assert.equal(seen[1].cookie.includes('second-account'), true);
    assert.equal(seen[1].cookie.includes('first-account'), false);
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
  }
});
