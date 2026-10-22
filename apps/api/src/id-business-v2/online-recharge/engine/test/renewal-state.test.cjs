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
      if (name === '../subscription-diagnostics.cjs')
        return require('../subscription-diagnostics.cjs');
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
  responseBody = account(true),
  renewalTarget,
  unauthenticatedPostStatus = 200,
  postThrows = false,
  postReadbackAccount = accountId,
  unchangedAfterPost = false,
  loginAccountId,
  verifiedCookie = false,
  installedToken,
  failedLoginPage,
  onRead,
  onPost,
  connectBrowser
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
    disposedPages: [],
    posts: [],
    guards: [],
    known: 0
  };
  let submitted = false;
  let liveBody = responseBody;
  const rpc = {
    beforeExternalSubmit: async (detail) => {
      assert.equal(submitted, false);
      effects.guards.push(detail);
      submitted = true;
    },
    wasSubmitted: () => submitted,
    wasPaymentConfirmed: () => true,
    recordKnownOutcome: () => {
      submitted = false;
      effects.known++;
    }
  };
  const post = async (transport, url, options) => {
    effects.posts.push({ transport, url, options });
    onPost?.();
    if (postThrows) throw new Error('Synthetic response lost');
    const status = transport === 'browser-context' ? 200 : unauthenticatedPostStatus;
    if (status === 200 && typeof renewalTarget === 'boolean' && !unchangedAfterPost)
      liveBody = account(renewalTarget, postReadbackAccount);
    return { status: () => status, json: async () => ({}) };
  };
  const browserContexts = [];
  const response = () => ({
    status: () => statuses.shift() ?? 403,
    json: async () => liveBody
  });
  const sessionAuth = {
    extractProfileFromToken: (value) => ({
      accountId: value === 'synthetic-refreshed-token' ? loginAccountId : accountId
    }),
    installChatGptSession: async (context, raw) => {
      context.installed = raw;
      return {
        sessionData: { ...(installedToken ? { accessToken: installedToken } : {}) },
        cookieVerified: verifiedCookie
      };
    },
    safeBootstrapDiagnostics: require('../upstream/session-auth').safeBootstrapDiagnostics,
    bootstrapChatGptSession: async (page, _raw, options) => {
      effects.logins++;
      assert.equal(typeof options.deadlineAt, 'number');
      assert.notEqual(options.manualVerification, true);
      if (loginFailure) {
        if (failedLoginPage) await page.goto(failedLoginPage);
        throw loginFailure;
      }
      await page.goto('https://chatgpt.com/');
      return { session: { accessToken: loginAccountId ? 'synthetic-refreshed-token' : token } };
    }
  };
  const newBrowserContext = () => {
    const pages = [];
    const context = {
      pages: () => pages,
      request: {
        fetch: async (url, options) => post('browser-context', url, options),
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
            assert.ok(args.timeoutMs <= 20000);
            effects.requests.push({ context, page, args, transport: 'browser-page' });
            await onRead?.(args);
            const nextFailure = failures.shift() || failure;
            if (nextFailure) throw nextFailure;
            return { status: statuses.shift() ?? 403, text: JSON.stringify(liveBody) };
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
      if (name === '../rpc.cjs') return rpc;
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
                fetch: async (url, options) => post('node-context', url, options),
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
            if (connectBrowser) return connectBrowser();
            return {
              browser: {
                newContext: async (options) => {
                  effects.contexts.push(options);
                  return newBrowserContext();
                }
              }
            };
          },
          closeTaskBrowser: async () => {
            effects.browserCloses = (effects.browserCloses || 0) + 1;
          }
        };
      if (name === '../plans.cjs') return require('../plans.cjs');
      if (name === '../subscription-diagnostics.cjs')
        return require('../subscription-diagnostics.cjs');
      throw new Error(`Unexpected transport ${name}`);
    }
  });
  return {
    api: module.exports,
    effects,
    newBrowserContext,
    browserContexts,
    submitted: () => submitted
  };
}

for (const [method, enabled] of [
  ['cancelAutoRenew', false],
  ['resumeAutoRenew', true]
]) {
  test(`${method} keeps both GETs and its single POST in the supplied logged-in context`, async () => {
    const f = queryFixture({
      statuses: [200, 200],
      responseBody: account(!enabled),
      renewalTarget: enabled,
      unauthenticatedPostStatus: 403
    });
    const context = f.newBrowserContext();
    const page = await context.newPage();
    await page.goto('https://chatgpt.com/');
    const result = await f.api[method](token, { page, browserContext: context });
    assert.equal(f.effects.posts[0]?.transport, 'browser-context');
    assert.equal(result.ok, true);
    assert.equal(result.data.autoRenewRaw, enabled);
    assert.equal(f.effects.requests.length, 2);
    assert.ok(f.effects.requests.every((item) => item.page === page));
    assert.equal(f.effects.posts.length, 1);
    assert.equal(f.effects.posts[0].transport, 'browser-context');
    assert.equal(f.effects.guards.length, 1);
    assert.equal(f.effects.known, 1);
    assert.equal(f.submitted(), false);
    assert.equal(f.effects.contexts.length, 0);
    assert.equal(f.effects.closes + f.effects.disposes + f.effects.pageCloses, 0);
  });
  test(`${method} owns one isolated session context and one task proxy until readback and cleanup`, async () => {
    const f = queryFixture({
      statuses: [200, 200],
      responseBody: account(!enabled),
      renewalTarget: enabled,
      unauthenticatedPostStatus: 403
    });
    const result = await f.api[method](token, {
      sessionRaw: 'synthetic-session-A',
      allowBrowserFallback: true
    });
    assert.equal(result.ok, true);
    assert.equal(f.effects.logins, 1);
    assert.equal(f.effects.browserConnections.length, 1);
    assert.equal(f.effects.contexts.length, 1);
    assert.equal(f.effects.proxies.length, 1);
    assert.equal(f.effects.posts.length, 1);
    assert.equal(f.effects.posts[0].transport, 'browser-context');
    assert.equal(f.effects.requests.length, 2);
    assert.equal(f.effects.requests[0].page, f.effects.requests[1].page);
    assert.equal(f.browserContexts[0].installed, 'synthetic-session-A');
    assert.equal(f.effects.closes, 1);
    assert.equal(f.effects.pageCloses, 1);
    assert.equal(f.effects.cleanups, 1);
    assert.equal(f.effects.disposes, 0);
  });
  for (const scenario of ['wrong account', 'unchanged state', 'lost response']) {
    test(`${method} ${scenario} never repeats a POST and releases its owned resources`, async () => {
      const f = queryFixture({
        statuses: [200, 200],
        responseBody: account(!enabled),
        renewalTarget: enabled,
        postReadbackAccount: scenario === 'wrong account' ? 'other-account' : accountId,
        unchangedAfterPost: scenario === 'unchanged state',
        postThrows: scenario === 'lost response'
      });
      const result = await f.api[method](token, {
        sessionRaw: 'synthetic-session',
        allowBrowserFallback: true
      });
      assert.equal(result.ok, false);
      assert.equal(result.resultUnknown, true);
      assert.equal(f.effects.posts.length, 1);
      assert.equal(f.effects.guards.length, 1);
      assert.equal(f.effects.known, 0);
      assert.equal(f.submitted(), true);
      assert.equal(f.effects.closes, 1);
      assert.equal(f.effects.cleanups, 1);
    });
  }
  test(`${method} stops on a foreign precheck account without a POST`, async () => {
    const f = queryFixture({ statuses: [200], responseBody: account(!enabled, 'other-account') });
    const result = await f.api[method](token, {
      sessionRaw: 'synthetic-session',
      allowBrowserFallback: true
    });
    assert.equal(result.ok, false);
    assert.equal(f.effects.posts.length, 0);
    assert.equal(f.effects.guards.length, 0);
    assert.equal(f.effects.closes, 1);
  });
  test(`${method} cannot replace the original account with a different login token`, async () => {
    const f = queryFixture({
      statuses: [200, 200],
      responseBody: account(!enabled, 'other-account'),
      renewalTarget: enabled,
      postReadbackAccount: 'other-account',
      loginAccountId: 'other-account'
    });
    const result = await f.api[method](token, {
      sessionRaw: 'synthetic-session',
      allowBrowserFallback: true
    });
    assert.equal(result.ok, false);
    assert.equal(f.effects.posts.length, 0);
    assert.equal(f.effects.guards.length, 0);
    assert.equal(f.effects.closes, 1);
  });
  test(`${method} respects the caller cancellation before allocating or submitting`, async () => {
    const f = queryFixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        f.api[method](token, {
          sessionRaw: 'synthetic-session',
          allowBrowserFallback: true,
          signal: controller.signal
        }),
      { code: 'LEASE_LOST' }
    );
    assert.equal(f.effects.contexts.length + f.effects.posts.length, 0);
  });
  test(`${method} abort after its one POST keeps the submission and cleans only owned resources`, async () => {
    const controller = new AbortController();
    const f = queryFixture({
      statuses: [200, 200],
      responseBody: account(!enabled),
      renewalTarget: enabled,
      onPost: () => controller.abort()
    });
    await assert.rejects(
      () =>
        f.api[method](token, {
          sessionRaw: 'synthetic-session',
          allowBrowserFallback: true,
          signal: controller.signal
        }),
      { code: 'LEASE_LOST' }
    );
    assert.equal(f.effects.posts.length, 1);
    assert.equal(f.effects.guards.length, 1);
    assert.equal(f.effects.requests.length, 1);
    assert.equal(f.submitted(), true);
    assert.equal(f.effects.known, 0);
    assert.equal(f.effects.closes, 1);
    assert.equal(f.effects.cleanups, 1);
  });
  test(`${method} login failure is controlled and releases its allocated context without mutation`, async () => {
    const f = queryFixture({ loginFailure: new Error('PRIVATE_SESSION_SENTINEL') });
    const result = await f.api[method](token, {
      sessionRaw: 'synthetic-session',
      allowBrowserFallback: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.resultUnknown, false);
    assert.equal(f.effects.posts.length + f.effects.guards.length, 0);
    assert.equal(f.effects.closes, 1);
    assert.equal(f.effects.pageCloses, 1);
    assert.equal(f.effects.cleanups, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SESSION_SENTINEL/);
  });
}

test('cancelled renewal closes a late browser connection before it can create a context', async () => {
  const controller = new AbortController();
  let connected, started;
  const connection = new Promise((resolve) => {
    connected = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = queryFixture({
    connectBrowser: async () => {
      started();
      return connection;
    }
  });
  const result = f.api.cancelAutoRenew(token, {
    sessionRaw: 'synthetic-session',
    allowBrowserFallback: true,
    signal: controller.signal
  });
  await ready;
  controller.abort();
  await assert.rejects(result, { code: 'LEASE_LOST' });
  connected({
    browser: {
      newContext: async () => {
        throw new Error('Late context forbidden');
      }
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.effects.browserCloses, 1);
  assert.equal(f.effects.cleanups, 1);
  assert.equal(f.effects.contexts.length + f.effects.posts.length, 0);
});

test('a completed payment does not block one separately guarded renewal request', async () => {
  const actual = require('../rpc.cjs');
  let submissions = 0;
  actual.configureTask({
    id: 'synthetic-renewal',
    workerId: 'synthetic',
    leaseId: 'synthetic',
    leaseVersion: 1
  });
  actual.setTransportForTest(async (method, args) => {
    assert.equal(method, 'beforeExternalSubmit');
    assert.equal(args.stage, 'renewal_update');
    submissions++;
    return { ok: true };
  });
  try {
    actual.recordKnownOutcome('success');
    assert.equal(actual.wasPaymentConfirmed(), true);
    await actual.beforeExternalSubmit({ stage: 'renewal_update', renewalAction: 'disable' });
    await assert.rejects(
      () => actual.beforeExternalSubmit({ stage: 'renewal_update', renewalAction: 'disable' }),
      { code: 'RESULT_UNKNOWN' }
    );
    assert.equal(actual.wasPaymentConfirmed(), true);
    assert.equal(submissions, 1);
  } finally {
    actual.setTransportForTest(null);
    actual.clearTask();
  }
});

test('renewal task mutation passes its full Session to the existing browser query path', async () => {
  const runnerSource = fs.readFileSync(path.join(__dirname, '../task-runner.cjs'), 'utf8');
  const calls = [];
  const module = { exports: {} };
  runInNewContext(runnerSource, {
    module,
    process: { env: {} },
    require(name) {
      if (name === 'node:path') return path;
      if (name === './rpc.cjs') return { recordKnownOutcome() {} };
      if (name === './security.cjs' || name === './upstream/mysql-store') return {};
      if (name === './upstream/session-auth') return { extractAccessTokenFromRaw: () => token };
      if (name === './upstream/subscription-check')
        return {
          cancelAutoRenew: async (_token, options) => {
            calls.push(options);
            return { ok: true };
          },
          resumeAutoRenew: async (_token, options) => {
            calls.push(options);
            return { ok: true };
          }
        };
      throw new Error('Unexpected isolated task import');
    }
  });
  for (const action of ['disable', 'enable'])
    await module.exports.execute(
      { operation: 'renewal', session: 'synthetic-session', payload: { action } },
      {}
    );
  assert.equal(calls.length, 2);
  for (const options of calls) {
    assert.equal(options.sessionRaw, 'synthetic-session');
    assert.equal(options.allowBrowserFallback, true);
  }
});

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

for (const [status, responseBody, hasFacts, matches] of [
  [401, { private: 'PRIVATE_ACCOUNT_DETAILS' }, false, false],
  [403, '<h1>PRIVATE_ACCOUNT_DETAILS</h1>', false, false],
  [200, account(true), true, true],
  [200, account(true, 'another-account'), true, false],
  [200, { private: 'PRIVATE_ACCOUNT_DETAILS' }, false, false]
])
  test(`unconfirmed independent login preserves failure after one same-page diagnostic GET: ${status}/${hasFacts}/${matches}`, async () => {
    const f = queryFixture({
      verifiedCookie: true,
      failedLoginPage: 'https://chatgpt.com/',
      statuses: [status],
      responseBody,
      loginFailure: Object.assign(new Error('PRIVATE_LOGIN_DETAILS'), {
        code: 'SESSION_NOT_CONFIRMED',
        bootstrapDiagnostics: {
          reason: 'visible_login_controls',
          authApiVerified: true,
          visibleLogin: true
        }
      })
    });
    const result = await f.api.querySubscriptionBySession(token, {
      sessionRaw: 'synthetic',
      allowBrowserFallback: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'SESSION_NOT_CONFIRMED');
    assert.equal(result.bootstrapDiagnostics.accountCheckHttpStatus, status);
    assert.equal(result.bootstrapDiagnostics.accountCheckHasAccountFacts, hasFacts);
    assert.equal(result.bootstrapDiagnostics.accountCheckIdentityMatches, matches);
    assert.equal(f.effects.requests.length, 1);
    assert.equal(f.effects.requests[0].page, f.effects.preparedPages[0]);
    assert.ok(
      f.effects.requests[0].args.timeoutMs > 0 && f.effects.requests[0].args.timeoutMs <= 5000
    );
    assert.equal(f.effects.logins, 1);
    assert.equal(f.effects.proxies.length, 1);
    assert.equal(f.effects.contexts.length, 1);
    assert.equal(f.browserContexts.length, 1);
    assert.equal(f.effects.requests[0].context, f.browserContexts[0]);
    assert.equal(f.effects.disposes, 0);
    assert.equal(f.effects.posts.length + f.effects.guards.length, 0);
    assert.equal(f.effects.closes, 1);
    assert.equal(f.effects.pageCloses, 1);
    assert.equal(f.effects.cleanups, 1);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  });

test('unconfirmed login diagnostic does not retry a failed GET or expose transport details', async () => {
  const f = queryFixture({
    verifiedCookie: true,
    failedLoginPage: 'https://chatgpt.com/',
    failure: Object.assign(new Error('PRIVATE_TRANSPORT_DETAILS'), { code: 'ECONNRESET' }),
    loginFailure: Object.assign(new Error('PRIVATE_LOGIN_DETAILS'), {
      code: 'SESSION_NOT_CONFIRMED',
      bootstrapDiagnostics: {
        reason: 'visible_login_controls',
        authApiVerified: true,
        visibleLogin: true
      }
    })
  });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'synthetic',
    allowBrowserFallback: true
  });
  assert.equal(result.errorCode, 'SESSION_NOT_CONFIRMED');
  assert.equal(f.effects.requests.length, 1);
  assert.equal(result.diagnostics[0].networkCode, 'ECONNRESET');
  assert.equal(f.effects.posts.length + f.effects.guards.length, 0);
  assert.equal(f.effects.closes, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});

test('unconfirmed login diagnostic rechecks a newly visible challenge before any GET', async () => {
  const f = queryFixture({
    verifiedCookie: true,
    failedLoginPage: 'https://chatgpt.com/',
    verificationResult: { cleared: false, code: 'VERIFICATION_TIMEOUT' },
    loginFailure: Object.assign(new Error('private'), {
      code: 'SESSION_NOT_CONFIRMED',
      bootstrapDiagnostics: {
        reason: 'visible_login_controls',
        authApiVerified: true,
        challengeDetected: false
      }
    })
  });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'synthetic',
    allowBrowserFallback: true
  });
  assert.equal(result.errorCode, 'SESSION_NOT_CONFIRMED');
  assert.equal(f.effects.requests.length, 0);
  assert.equal(f.effects.posts.length + f.effects.guards.length, 0);
  assert.equal(f.effects.closes, 1);
});

test('unconfirmed login diagnostic uses only the verified refreshed token on its original page', async () => {
  const f = queryFixture({
    verifiedCookie: true,
    installedToken: 'synthetic-refreshed-token',
    loginAccountId: accountId,
    failedLoginPage: 'https://chatgpt.com/',
    statuses: [200],
    loginFailure: Object.assign(new Error('private'), {
      code: 'SESSION_NOT_CONFIRMED',
      bootstrapDiagnostics: { reason: 'visible_login_controls', authApiVerified: true }
    })
  });
  const result = await f.api.querySubscriptionBySession(token, {
    sessionRaw: 'synthetic',
    allowBrowserFallback: true
  });
  assert.equal(result.errorCode, 'SESSION_NOT_CONFIRMED');
  assert.equal(result.bootstrapDiagnostics.accountCheckIdentityMatches, true);
  assert.equal(f.effects.requests.length, 1);
  assert.equal(f.effects.requests[0].args.token, 'synthetic-refreshed-token');
  assert.equal(f.effects.requests[0].page, f.effects.preparedPages[0]);
  assert.equal(f.effects.posts.length + f.effects.guards.length, 0);
});

test('unconfirmed login diagnostic stops on lease cancellation and releases its original context', async () => {
  const control = new AbortController();
  const f = queryFixture({
    verifiedCookie: true,
    failedLoginPage: 'https://chatgpt.com/',
    onRead: () => control.abort(),
    loginFailure: Object.assign(new Error('private'), {
      code: 'SESSION_NOT_CONFIRMED',
      bootstrapDiagnostics: { reason: 'visible_login_controls', authApiVerified: true }
    })
  });
  await assert.rejects(
    f.api.querySubscriptionBySession(token, {
      sessionRaw: 'synthetic',
      allowBrowserFallback: true,
      signal: control.signal
    }),
    { code: 'LEASE_LOST' }
  );
  assert.equal(f.effects.requests.length, 1);
  assert.equal(f.effects.posts.length + f.effects.guards.length, 0);
  assert.equal(f.effects.closes, 1);
  assert.equal(f.effects.pageCloses, 1);
  assert.equal(f.effects.cleanups, 1);
});

for (const [verifiedCookie, failedLoginPage, code, reason] of [
  [false, 'https://chatgpt.com/', 'SESSION_NOT_CONFIRMED', 'visible_login_controls'],
  [true, 'https://auth.openai.com/', 'SESSION_NOT_CONFIRMED', 'login_redirect'],
  [true, 'https://chatgpt.com/', 'VERIFICATION_TIMEOUT', 'verification_failed'],
  [true, 'https://chatgpt.com/', 'ACCOUNT_MISMATCH', 'runtime_failed']
])
  test(`unconfirmed login never starts a diagnostic outside the guarded same-page case: ${verifiedCookie}/${code}/${reason}`, async () => {
    const f = queryFixture({
      verifiedCookie,
      failedLoginPage,
      loginFailure: Object.assign(new Error('PRIVATE_LOGIN_DETAILS'), {
        code,
        bootstrapDiagnostics: {
          reason,
          authApiVerified: verifiedCookie,
          challengeDetected: reason === 'verification_failed'
        }
      })
    });
    const result = await f.api.querySubscriptionBySession(token, {
      sessionRaw: 'synthetic',
      allowBrowserFallback: true
    });
    assert.equal(result.ok, false);
    assert.equal(f.effects.requests.length, 0);
    assert.equal(f.effects.closes, 1);
    assert.equal(f.effects.posts.length + f.effects.guards.length, 0);
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

test('real Chromium failed-login diagnostic reads once in its original authenticated context and cannot authorize success', async () => {
  const { chromium } = require('../upstream/node_modules/playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const status of [401, 200]) {
      const seen = [];
      let contexts = 0,
        closed = 0;
      const f = queryFixture({
        verifiedCookie: true,
        failedLoginPage: 'https://chatgpt.com/',
        loginFailure: Object.assign(new Error('PRIVATE_LOGIN_DETAILS'), {
          code: 'SESSION_NOT_CONFIRMED',
          bootstrapDiagnostics: {
            reason: 'visible_login_controls',
            authApiVerified: true,
            visibleLogin: true
          }
        }),
        connectBrowser: async () => ({
          browser: {
            newContext: async (options) => {
              contexts++;
              assert.equal(options.proxy.server, 'http://task-proxy.invalid:8123');
              const context = await browser.newContext();
              await context.addCookies([
                {
                  name: 'fixture-session',
                  value: 'same-diagnostic-context',
                  domain: 'chatgpt.com',
                  path: '/',
                  secure: true
                }
              ]);
              const close = context.close.bind(context);
              context.close = async () => {
                closed++;
                await close();
              };
              await context.route('**/*', async (route) => {
                const request = route.request();
                assert.equal(request.method(), 'GET');
                assert.equal(new URL(request.url()).origin, 'https://chatgpt.com');
                if (request.url().includes('/backend-api/accounts/check/')) {
                  seen.push({
                    cookie: request.headers().cookie,
                    bearer: request.headers().authorization
                  });
                  return route.fulfill({
                    status,
                    contentType: 'application/json',
                    body: JSON.stringify({ ...account(true), private: 'PRIVATE_ACCOUNT_DETAILS' })
                  });
                }
                return route.fulfill({ contentType: 'text/html', body: '<button>Log in</button>' });
              });
              return context;
            }
          }
        })
      });
      const result = await f.api.querySubscriptionBySession(token, {
        sessionRaw: 'synthetic',
        allowBrowserFallback: true
      });
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, 'SESSION_NOT_CONFIRMED');
      assert.equal(result.bootstrapDiagnostics.accountCheckHttpStatus, status);
      assert.equal(result.bootstrapDiagnostics.accountCheckIdentityMatches, status === 200);
      assert.equal(contexts, 1);
      assert.equal(closed, 1);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].cookie.includes('fixture-session=same-diagnostic-context'), true);
      assert.equal(seen[0].bearer, `Bearer ${token}`);
      assert.equal(f.effects.posts.length + f.effects.guards.length, 0);
      assert.equal(f.effects.disposes, 0);
      assert.equal(f.effects.proxies.length, 1);
      assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
    }
  } finally {
    await browser.close();
  }
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
