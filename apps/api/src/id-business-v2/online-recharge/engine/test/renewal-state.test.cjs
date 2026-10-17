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
function queryFixture({ statuses = [200], failure, loginFailure, contextFailure } = {}) {
  const effects = {
    proxies: [],
    requests: [],
    contexts: [],
    closes: 0,
    disposes: 0,
    cleanups: 0,
    logins: 0,
    browserConnections: []
  };
  const browserContexts = [];
  const response = () => ({
    status: () => statuses.shift() ?? 403,
    json: async () => account(true)
  });
  const sessionAuth = {
    extractProfileFromToken: () => ({ accountId }),
    installChatGptSession: async (context, raw) => {
      context.installed = raw;
      return { sessionData: {} };
    },
    bootstrapChatGptSession: async (_page, _raw, options) => {
      effects.logins++;
      assert.equal(options.manualVerification, true);
      if (loginFailure) throw loginFailure;
      return { session: { accessToken: token } };
    }
  };
  const newBrowserContext = () => {
    const context = {
      request: {
        get: async (...args) => {
          effects.requests.push({ context, args });
          return response();
        }
      },
      newPage: async () => ({}),
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

test('logged-in recharge uses the same cookie request context, without recreating or disposing it', async () => {
  const f = queryFixture();
  const context = f.newBrowserContext();
  const result = await f.api.querySubscriptionBySession(token, { browserContext: context });
  assert.equal(result.ok, true);
  assert.equal(f.effects.requests[0].context, context);
  assert.equal(f.effects.contexts.length, 0);
  assert.equal(f.effects.proxies.length, 0);
  assert.equal(f.effects.closes + f.effects.disposes, 0);
});

test('independent 403 enters one normal isolated login using the same resolved task proxy', async () => {
  const f = queryFixture({ statuses: [403, 200] });
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
  assert.equal(f.effects.contexts[0].proxy.server, f.effects.contexts[1].proxy.server);
  assert.equal(
    f.effects.contexts[1].proxy.server,
    f.effects.browserConnections[0].proxyConfig.server
  );
  assert.equal(f.browserContexts[0].installed, 'synthetic-session-A');
  assert.equal(f.effects.closes, 1);
  assert.equal(f.effects.disposes, 1);
  assert.equal(f.effects.cleanups, 2);
});

test('repeated 403 stops after one browser check and does not label the session expired', async () => {
  const f = queryFixture({ statuses: [403, 403] });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'synthetic',
    allowBrowserFallback: true
  });
  assert.equal(result.errorCode, 'UPSTREAM_FORBIDDEN');
  assert.equal(f.effects.requests.length, 2);
  assert.equal(f.effects.logins, 1);
  assert.equal(f.effects.closes, 1);
});

test('401 is login failure and never creates a fallback browser', async () => {
  const f = queryFixture({ statuses: [401] });
  assert.equal(
    (
      await f.api.querySubscriptionBySession(token, {
        sessionRaw: 'synthetic',
        allowBrowserFallback: true
      })
    ).errorCode,
    'SESSION_INVALID'
  );
  assert.equal(f.effects.logins, 0);
});

for (const [message, code] of [
  ['Timeout 20000ms exceeded', 'NETWORK_TIMEOUT'],
  ['SOCKS proxy connection refused', 'PROXY_UNAVAILABLE']
])
  test(`query classifies ${code} without exposing the raw transport error`, async () => {
    const f = queryFixture({ failure: new Error(message) });
    const result = await f.api.querySubscriptionBySession(token);
    assert.equal(result.errorCode, code);
    assert.equal(JSON.stringify(result).includes(message), false);
    assert.equal(f.effects.disposes, 1);
  });

test('browser manual verification stops and always closes the isolated context', async () => {
  const f = queryFixture({
    statuses: [403],
    loginFailure: Object.assign(new Error('challenge'), { code: 'HUMAN_VERIFICATION_REQUIRED' })
  });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'synthetic',
    allowBrowserFallback: true
  });
  assert.equal(result.errorCode, 'HUMAN_VERIFICATION_REQUIRED');
  assert.equal(result.statusCode, 403);
  assert.equal(f.effects.closes, 1);
  assert.equal(f.effects.requests.length, 1);
});

test('sequential independent tasks get different contexts and never inherit previous cookies', async () => {
  const f = queryFixture({ statuses: [403, 200, 403, 200] });
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
