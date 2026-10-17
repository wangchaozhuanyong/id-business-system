'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const outcomes = require('../outcomes.cjs');
const rpc = require('../rpc.cjs');
const security = require('../security.cjs');
const credentialClient = require('../credential-client.cjs');
const store = require('../upstream/mysql-store');
const { executeThirdParty } = require('../third-party.cjs');
const { evaluateSubscription, recheck } = require('../confirmation.cjs');
const task = () => ({
  id: 'synthetic-task',
  workerId: 'test-worker',
  leaseId: 'test-lease',
  leaseVersion: 2,
  plan: 'pro_5x',
  session: '{}',
  provider: 'third_party',
  code: null
});
const card = () => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  card_number: '4242424242424242',
  card_expiry: '12/29',
  card_cvc: '123',
  leaseId: 'card-lease',
  leaseVersion: 7
});
test.afterEach(() => {
  store.clearCredentials();
  rpc.setTransportForTest(null);
  credentialClient.setRequesterForTest(null);
  rpc.clearTask();
  security.clearSecrets();
});
const sessionBearer = (accountId = 'fixture-account', userId = 'fixture-user', revision = 'old') =>
  `synthetic.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: userId },
      'https://api.openai.com/profile': { email: 'fixture@example.invalid' },
      jti: revision
    })
  ).toString('base64url')}.synthetic`;
async function sessionInstallFixture({
  status = 200,
  body,
  headers = {},
  original = {},
  failure
} = {}) {
  const filename = path.resolve(__dirname, '../upstream/session-auth.js');
  const source = await fs.readFile(filename, 'utf8');
  const module = { exports: {} };
  const logs = [];
  vm.runInNewContext(
    source,
    {
      module,
      exports: module.exports,
      Buffer,
      process: { env: {} },
      performance,
      console: {
        log: (...items) => logs.push(items.join(' ')),
        warn: (...items) => logs.push(items.join(' '))
      },
      require: (name) => require(path.resolve(path.dirname(filename), name))
    },
    { filename }
  );
  const session = {
    accessToken: sessionBearer(),
    sessionToken: 'synthetic-cookie-only',
    user: { id: 'fixture-user', email: 'fixture@example.invalid', name: 'Original' },
    account: { id: 'fixture-account' },
    expires: '2030-01-01T00:00:00.000Z',
    ...original
  };
  const calls = { cookies: [], routes: [], scripts: [], realSessionRequests: 0 };
  const context = {
    newPage: async () => ({
      goto: async (url) => {
        if (url.endsWith('/api/auth/session')) {
          calls.realSessionRequests++;
          if (failure) throw failure;
        }
        return { status: () => status, headers: () => headers };
      },
      evaluate: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      close: async () => {}
    }),
    addCookies: async (cookies) => calls.cookies.push(...cookies),
    cookies: async () => calls.cookies,
    addInitScript: async (script, payload) => calls.scripts.push({ script, payload }),
    route: async (pattern, handler) => calls.routes.push({ pattern, handler })
  };
  return {
    api: module.exports,
    context,
    session,
    calls,
    logs,
    install: () => module.exports.installChatGptSession(context, JSON.stringify(session))
  };
}
test('verified Cookie refresh replaces the stale bearer in session, fetch and routed requests', async () => {
  const refreshed = sessionBearer('fixture-account', 'fixture-user', 'refreshed');
  const body = {
    accessToken: refreshed,
    user: { id: 'fixture-user', name: 'Verified' },
    account: { id: 'fixture-account' },
    expires: '2031-01-01T00:00:00.000Z'
  };
  const f = await sessionInstallFixture({ body });
  const installed = await f.install();
  assert.equal(installed.cookieVerified, true);
  assert.equal(installed.sessionData.accessToken, refreshed);
  assert.equal(installed.sessionData.user.name, 'Verified');
  assert.equal(installed.sessionData.expires, body.expires);
  assert.equal(installed.sessionData.sessionToken, f.session.sessionToken);
  assert.equal(f.calls.realSessionRequests, 1);
  assert.equal(f.calls.scripts[0].payload.accessToken, refreshed);
  let routedHeaders;
  await f.calls.routes.at(-1).handler({
    request: () => ({
      url: () => 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27',
      resourceType: () => 'fetch',
      headers: () => ({})
    }),
    continue: async (options) => {
      routedHeaders = options?.headers;
    }
  });
  assert.equal(routedHeaders.Authorization, `Bearer ${refreshed}`);
  let routedSession;
  await f.calls.routes[0].handler({
    fulfill: async (options) => {
      routedSession = JSON.parse(options.body);
    }
  });
  assert.equal(routedSession.accessToken, refreshed);
  const window = {
    fetch: async () => {
      throw new Error('Synthetic fixture forbids network');
    }
  };
  vm.runInNewContext(
    `(${f.calls.scripts[0].script.toString()})(${JSON.stringify(f.calls.scripts[0].payload)})`,
    {
      window,
      localStorage: { setItem() {} },
      Response
    }
  );
  assert.equal((await (await window.fetch('/api/auth/session')).json()).accessToken, refreshed);
  assert.equal(f.logs.join('\n').includes(refreshed), false);
  assert.equal(security.redactText(refreshed).includes(refreshed), false);
});
test('refreshed Cookie credentials cannot switch account, user or discard identity binding', async () => {
  const good = {
    accessToken: sessionBearer('fixture-account', 'fixture-user', 'refreshed'),
    user: { id: 'fixture-user' },
    account: { id: 'fixture-account' }
  };
  for (const body of [
    { ...good, accessToken: sessionBearer('other-account', 'fixture-user', 'refreshed') },
    { ...good, accessToken: sessionBearer('fixture-account', 'other-user', 'refreshed') },
    { ...good, accessToken: sessionBearer('', 'fixture-user', 'refreshed') },
    { ...good, accessToken: sessionBearer('fixture-account', '', 'refreshed') },
    { ...good, account: { id: 'other-account' } },
    { ...good, user: { id: 'other-user' } }
  ]) {
    const f = await sessionInstallFixture({ body });
    await assert.rejects(
      f.install,
      (error) =>
        error.code === 'ACCOUNT_MISMATCH' &&
        !/fixture-account|fixture-user|synthetic\./.test(error.message)
    );
    assert.equal(f.calls.scripts.length, 0);
    assert.equal(f.calls.routes.length, 0);
  }
  const inconsistent = await sessionInstallFixture({
    body: good,
    original: { account: { id: 'other-account' } }
  });
  await assert.rejects(inconsistent.install, (error) => error.code === 'ACCOUNT_MISMATCH');
  const inconsistentUser = await sessionInstallFixture({
    body: good,
    original: { user: { id: 'other-user' } }
  });
  await assert.rejects(inconsistentUser.install, (error) => error.code === 'ACCOUNT_MISMATCH');
  const unbound = await sessionInstallFixture({
    body: good,
    original: { accessToken: 'opaque-synthetic-token', user: null, account: null }
  });
  await assert.rejects(unbound.install, (error) => error.code === 'ACCOUNT_MISMATCH');
});
test('same or missing fresh bearer retains the original session fields', async () => {
  for (const accessToken of [undefined, sessionBearer()]) {
    const f = await sessionInstallFixture({
      body: {
        ...(accessToken ? { accessToken } : {}),
        user: { id: 'fixture-user', name: 'Changed' },
        expires: '2031-01-01T00:00:00.000Z'
      }
    });
    const installed = await f.install();
    assert.equal(installed.cookieVerified, true);
    assert.deepEqual(JSON.parse(JSON.stringify(installed.sessionData)), {
      ...f.session,
      authProvider: 'google-oauth2'
    });
  }
});
test('Cookie identity is never accepted from a forbidden response or challenge page', async () => {
  const body = {
    accessToken: sessionBearer('fixture-account', 'fixture-user', 'refreshed'),
    user: { id: 'fixture-user' }
  };
  const unauthorized = await sessionInstallFixture({ status: 401, body });
  await assert.rejects(unauthorized.install, (error) => error.code === 'SESSION_INVALID');
  for (const response of [
    { status: 403 },
    { status: 429 },
    { status: 500 },
    { status: 200, headers: { 'cf-mitigated': 'challenge' } }
  ]) {
    const f = await sessionInstallFixture({ ...response, body });
    const installed = await f.install();
    assert.equal(installed.cookieVerified, false);
    assert.equal(installed.sessionData.accessToken, f.session.accessToken);
  }
});
test('ambiguous HTTP 200 bodies stay unverified while an exact empty session is rejected', async () => {
  for (const body of [
    { error: 'temporary_failure' },
    {
      error: 'refresh_failed',
      accessToken: sessionBearer('fixture-account', 'fixture-user', 'untrusted'),
      user: { id: 'fixture-user' }
    },
    [],
    '<html>temporary failure</html>'
  ]) {
    const f = await sessionInstallFixture({ body });
    const installed = await f.install();
    assert.equal(installed.cookieVerified, false);
    assert.equal(installed.sessionData.accessToken, f.session.accessToken);
  }
  const empty = await sessionInstallFixture({ body: {} });
  await assert.rejects(empty.install, (error) => error.code === 'SESSION_INVALID');
});
test('Cookie probe timeout retains the original credential without manufacturing verification', async () => {
  const f = await sessionInstallFixture({
    failure: Object.assign(new Error('synthetic_timeout'), { name: 'TimeoutError' })
  });
  const installed = await f.install();
  assert.equal(installed.cookieVerified, false);
  assert.equal(installed.sessionData.accessToken, f.session.accessToken);
  assert.equal(f.calls.realSessionRequests, 1);
});
test('independent subscription and renewal preserve an authentication identity rejection', async () => {
  const filename = path.resolve(__dirname, '../upstream/subscription-check.js');
  const module = { exports: {} };
  let mismatches = 0,
    resourcesClosed = 0;
  const page = { close: async () => {} };
  const context = {
    newPage: async () => page,
    close: async () => {
      resourcesClosed++;
    }
  };
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
    module,
    exports: module.exports,
    process: { env: {} },
    Buffer,
    URL,
    AbortController,
    require: (name) => {
      if (name.startsWith('node:')) return require(name);
      if (name === 'playwright') return { request: {} };
      if (name === '../rpc.cjs') return { taskSignal: () => undefined, wasSubmitted: () => false };
      if (name === './session-auth')
        return {
          extractProfileFromToken: () => ({ accountId: 'fixture-account' }),
          installChatGptSession: async () => {
            mismatches++;
            throw Object.assign(new Error('Synthetic identity rejection'), {
              code: 'ACCOUNT_MISMATCH'
            });
          }
        };
      if (name === './playwright-proxy')
        return {
          preparePlaywrightProxy: async () => ({
            cleanup: async () => {
              resourcesClosed++;
            }
          })
        };
      if (name === './browser-runtime')
        return {
          connectTaskBrowser: async () => ({
            browser: { newContext: async () => context },
            realUserAgent: 'Synthetic'
          }),
          closeTaskBrowser: async () => {
            resourcesClosed++;
          }
        };
      if (name === './human-verification')
        return { prepareVerificationPage: async () => {}, disposeVerificationPage: async () => {} };
      throw new Error('Synthetic authentication fixture forbids other dependencies');
    }
  });
  const options = { sessionRaw: 'synthetic-session', allowBrowserFallback: true };
  for (const operation of ['querySubscriptionBySession', 'cancelAutoRenew', 'resumeAutoRenew']) {
    const result = await module.exports[operation](sessionBearer(), options);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'ACCOUNT_MISMATCH');
    assert.equal(result.statusCode, 409);
    assert.match(result.error, /身份|账号|用户/);
    assert.doesNotMatch(result.error, /网络|fixture-account|synthetic-session/);
    assert.notEqual(result.resultUnknown, true);
  }
  assert.equal(mismatches, 3);
  assert.equal(resourcesClosed, 9);
});
test('authentication redirect never proves payment', () => {
  assert.equal(outcomes.isVerifiedPaymentRedirect('https://chatgpt.com/auth/login'), false);
  assert.equal(
    outcomes.isVerifiedPaymentRedirect('https://chatgpt.com/auth/login?redirect_status=succeeded'),
    false
  );
  assert.equal(
    outcomes.isVerifiedPaymentRedirect(
      'https://chatgpt.com.evil.invalid/?redirect_status=succeeded'
    ),
    false
  );
  assert.equal(
    outcomes.isVerifiedPaymentRedirect('https://chatgpt.com/?redirect_status=succeeded'),
    true
  );
});
test('negative payment log and runtime error cannot override structured failure', () => {
  assert.deepEqual(
    outcomes.analyzeProcessOutput('尚未支付成功\n❌ [运行时错误]: synthetic_failure'),
    { status: 'failed', shouldRetry: false }
  );
  assert.deepEqual(outcomes.analyzeProcessOutput('PAYMENT_SUCCESS', { resultUnknown: true }), {
    status: 'result_unknown',
    shouldRetry: false
  });
});
test('provider unpaid and inactive are never terminal successes', () => {
  for (const status of ['unpaid', 'inactive', 'not succeeded', 'success_pending'])
    assert.equal(outcomes.isSuccessGptApiStatus(status), false);
  assert.equal(outcomes.isSuccessGptApiStatus(' SUCCESS '), true);
});
test('actual Stripe waiter does not accept a login redirect', async () => {
  process.env.PAYMENT_RESULT_TIMEOUT_MS = '20';
  process.env.CAPTCHA_OVERLAY_WAIT_MS = '20';
  const locator = {
    first() {
      return this;
    },
    nth() {
      return this;
    },
    filter() {
      return this;
    },
    count: async () => 0,
    isVisible: async () => false,
    textContent: async () => 'Login'
  };
  let body = 'Login';
  const page = {
    url: () => 'https://chatgpt.com/auth/login',
    setDefaultTimeout() {},
    locator: () => locator,
    getByRole: () => locator,
    getByText: () => locator,
    frames: () => [],
    evaluate: async () => false,
    textContent: async () => body,
    waitForTimeout: async () => new Promise((r) => setTimeout(r, 25))
  };
  const stripe = require('../upstream/stripe-payment');
  const result = await stripe.waitForPaymentResult(page, 'Synthetic');
  assert.equal(result.success, false);
  assert.equal(result.resultUnknown, true);
  body = '尚未支付成功';
  const negative = await stripe.waitForPaymentResult(page, 'Synthetic');
  assert.equal(negative.success, false);
  assert.equal(negative.resultUnknown, true);
  const post = await stripe.handlePostSubmitPhase(page);
  assert.equal(post.action, 'continue');
});
test('same account and exact Pro variant required for confirmation', () => {
  const result = (rawPlan, account = 'acct-test') => ({
    ok: true,
    data: { rawPlan, upstreamAccountId: account, hasActiveSubscription: true }
  });
  assert.equal(
    evaluateSubscription('pro_5x', 'acct-test', result('chatgptprolite')).verified,
    true
  );
  assert.equal(
    evaluateSubscription('pro_20x', 'acct-test', result('chatgptprolite')).verified,
    false
  );
  assert.equal(evaluateSubscription('pro_20x', 'acct-test', result('pro')).verified, false);
  assert.equal(
    evaluateSubscription('pro_20x', 'acct-test', result('chatgptpro', 'other')).verified,
    false
  );
  assert.equal(
    evaluateSubscription('plus', 'acct-test', {
      ok: true,
      data: { accountId: 'acct-test', rawPlan: 'plus', hasActiveSubscription: true }
    }).verified,
    false
  );
});
test('RPC asset mutations retain UUID card and both leases', async () => {
  const t = task();
  rpc.configureTask(t);
  const calls = [];
  rpc.setTransportForTest(async (method, args) => {
    calls.push({ method, args });
    return method === 'reserveCard' ? { ...card(), card_cvc: undefined } : { ok: true };
  });
  credentialClient.setRequesterForTest(() => '123');
  const resource = await store.reserveCard(t.id);
  await store.recordCardDecline(resource.id);
  await store.releaseCard(resource.id);
  const args = calls.find((c) => c.method === 'recordCardDecline').args;
  assert.equal(args.cardId, card().id);
  assert.equal(args.cardLeaseId, 'card-lease');
  assert.equal(args.cardLeaseVersion, 7);
  assert.equal(args.taskId, t.id);
  assert.equal(args.leaseId, t.leaseId);
  assert.equal(resource.card_cvc, null);
});
test('missing transient CVC waits rather than selecting another card', async () => {
  rpc.configureTask(task());
  let selections = 0;
  rpc.setTransportForTest(async (method) => {
    if (method === 'reserveCard') {
      selections++;
      return { ...card(), card_cvc: undefined };
    }
    return { ok: true };
  });
  credentialClient.setRequesterForTest(() => '');
  await assert.rejects(
    () => store.reserveCard(task().id),
    (e) => e.code === 'PENDING_CREDENTIALS'
  );
  assert.equal(selections, 1);
});
test('unknown submitted payment retains backend ownership and clears worker CVC', async () => {
  rpc.configureTask(task());
  const calls = [];
  rpc.setTransportForTest(async (method) => {
    calls.push(method);
    return method === 'reserveCard' ? { ...card(), card_cvc: undefined } : { ok: true };
  });
  credentialClient.setRequesterForTest(() => '123');
  const resource = await store.reserveCard(task().id);
  let submitLease;
  rpc.setTransportForTest(async (method, args) => {
    calls.push(method);
    if (method === 'beforeExternalSubmit') submitLease = args;
    return { ok: true };
  });
  await rpc.beforeExternalSubmit();
  await store.releaseCard(resource.id);
  assert.equal(submitLease.cardId, resource.id);
  assert.equal(submitLease.cardLeaseId, 'card-lease');
  assert.equal(submitLease.cardLeaseVersion, 7);
  assert.equal(calls.includes('releaseCard'), false);
  assert.equal(resource.card_cvc, null);
});
test('billing RPC never contains PAN/CVC and unknown amount remains null', async () => {
  rpc.configureTask(task());
  let input;
  rpc.setTransportForTest(async (_, args) => {
    input = args;
    return { ok: true };
  });
  await store.createBillingRecord({
    card_number: card().card_number,
    card_cvc: '123',
    amount: null,
    currency: 'PHP'
  });
  assert.equal(input.card_number, undefined);
  assert.equal(input.card_cvc, undefined);
  assert.equal(input.amount, null);
  assert.equal(input.amountSource, 'unknown');
});
test('confirmed payment never releases backend card even if a usage RPC fails', async () => {
  rpc.configureTask(task());
  const calls = [];
  rpc.setTransportForTest(async (method) => {
    calls.push(method);
    if (method === 'recordCardUsage') throw new Error('synthetic write failure');
    return method === 'reserveCard' ? { ...card(), card_cvc: undefined } : { ok: true };
  });
  credentialClient.setRequesterForTest(() => '123');
  const resource = await store.reserveCard(task().id);
  await assert.rejects(() => store.recordCardUsage(resource.id));
  await store.releaseCard(resource.id);
  assert.equal(calls.includes('releaseCard'), false);
  assert.equal(resource.card_cvc, null);
});
function thirdFixture(
  status,
  submit = { success: true, orderId: 'provider-order', taskId: 'provider-task' }
) {
  const calls = { submit: 0, reserve: 0, usage: 0, cancel: 0, billing: 0, request: null };
  const client = {
    inspectPay: async () => ({ success: true }),
    submitPay: async (_, input) => {
      calls.submit++;
      calls.request = { ...input, newCard: { ...input.newCard } };
      return submit;
    },
    queryTask: async () => ({
      success: true,
      rawStatus: status,
      data: { order_id: 'provider-order', task_id: 'provider-task', result: { ok: true } }
    }),
    queryOrder: async () => ({ success: true, rawStatus: status, data: {} })
  };
  const store = {
    reserveCard: async () => {
      calls.reserve++;
      return card();
    },
    getActiveProxy: async () => null,
    recordCardUsage: async () => {
      calls.usage++;
    },
    releaseCard: async () => {},
    recordCardDecline: async () => {}
  };
  return {
    calls,
    injected: {
      client,
      store,
      sleep: async () => {},
      beforeSubmit: async () => {},
      preflight: async () => ({ allowed: true }),
      confirm: async () => ({ verified: true, source: 'subscription', targetPlan: 'pro_5x' })
    }
  };
}
test('third party unknown/inactive polls once and never resubmits/rotates/cancels', async () => {
  const fixture = thirdFixture('inactive');
  const result = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    fixture.injected
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(fixture.calls.submit, 1);
  assert.equal(fixture.calls.reserve, 1);
  assert.equal(fixture.calls.usage, 0);
  assert.equal(fixture.calls.cancel, 0);
  assert.equal(fixture.calls.billing, 0);
});
test('third party timeout after submit is never a retryable failure', async () => {
  const fixture = thirdFixture('', { success: false, error: 'synthetic timeout' });
  const result = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    fixture.injected
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(fixture.calls.submit, 1);
});
test('third party conflict/throttle/timeout HTTP responses remain unknown and cannot release a code', async () => {
  for (const status of [408, 409, 429, 500]) {
    const fixture = thirdFixture('', { success: false, status });
    const result = await executeThirdParty(
      task(),
      { gptApi: {}, gptApiMaxPolls: 1 },
      fixture.injected
    );
    assert.equal(result.resultUnknown, true);
    assert.notEqual(result.definitiveFailure, true);
    assert.equal(fixture.calls.submit, 1);
  }
  const disabled = thirdFixture('success');
  assert.equal(
    (await executeThirdParty(task(), { gptApi: { enabled: false } }, disabled.injected)).success,
    false
  );
  assert.equal(disabled.calls.submit, 0);
});
test('third party success requires confirmation and stable non-CDK task key', async () => {
  const fixture = thirdFixture('success');
  const result = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    fixture.injected
  );
  assert.equal(result.confirmedPaid, true);
  assert.equal(fixture.calls.usage, 1);
  assert.equal(fixture.calls.request.idempotencyKey, 'task-synthetic-task');
  assert.equal(result.cardLast4, '4242');
  const uncertain = thirdFixture('paid');
  uncertain.injected.confirm = async () => ({ verified: false });
  const pending = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    uncertain.injected
  );
  assert.equal(pending.resultUnknown, true);
  assert.equal(uncertain.calls.usage, 0);
});
test('third party supplier response for another order stays unknown', async () => {
  const fixture = thirdFixture('success');
  fixture.injected.client.queryTask = async () => ({
    success: true,
    rawStatus: 'success',
    data: { order_id: 'other-order' }
  });
  assert.equal(
    (await executeThirdParty(task(), { gptApi: {}, gptApiMaxPolls: 1 }, fixture.injected))
      .resultUnknown,
    true
  );
  assert.equal(fixture.calls.usage, 0);
});
test('recheck performs only original order and subscription reads', async () => {
  const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')}.x`;
  const t = {
    ...task(),
    session: JSON.stringify({ accessToken: token }),
    payload: {
      recheckTaskId: 'original',
      originalProvider: 'third_party',
      providerOrderId: 'order',
      providerTaskId: 'provider-task',
      targetPlan: 'pro_5x'
    }
  };
  let reads = 0;
  const result = await recheck(
    t,
    {},
    {
      client: {
        queryTask: async (_, id) => {
          assert.equal(id, 'provider-task');
          reads++;
          return { success: true, rawStatus: 'success', data: { order_id: 'order', task_id: id } };
        }
      },
      query: async () => {
        reads++;
        return {
          ok: true,
          data: {
            upstreamAccountId: 'acct-test',
            rawPlan: 'chatgptprolite',
            hasActiveSubscription: true
          }
        };
      }
    }
  );
  assert.equal(result.confirmedPaid, true);
  assert.equal(reads, 2);
});
test('recheck generic Pro cannot release a code as conclusively failed', async () => {
  const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')}.x`;
  const t = {
    ...task(),
    session: JSON.stringify({ accessToken: token }),
    payload: {
      recheckTaskId: 'original',
      originalProvider: 'third_party',
      providerOrderId: 'order',
      providerTaskId: 'provider-task',
      targetPlan: 'pro_5x'
    }
  };
  const result = await recheck(
    t,
    {},
    {
      client: {
        queryTask: async () => ({
          success: true,
          rawStatus: 'failed',
          data: { order_id: 'order', task_id: 'provider-task' }
        })
      },
      query: async () => ({
        ok: true,
        data: { upstreamAccountId: 'acct-test', rawPlan: 'pro', hasActiveSubscription: true }
      })
    }
  );
  assert.equal(result.resultUnknown, true);
  assert.equal(result.definitiveFailure, false);
});
test('log redaction hides dynamic secrets and protected debug URL only survives structured result', () => {
  security.rememberSecrets({
    card_cvc: '123',
    accessToken: 'synthetic-access-token',
    apiKey: 'synthetic-key'
  });
  const line = security.redactText(
    '123 synthetic-access-token synthetic-key 4242424242424242 https://chatgpt.com/checkout/abc?token=synthetic-secret'
  );
  assert.equal(
    /123|synthetic-access-token|synthetic-key|4242424242424242|synthetic-secret/.test(line),
    false
  );
  const result = security.sanitizeResult({
    debugOnly: true,
    checkoutUrl: 'https://chatgpt.com/checkout/abc?token=synthetic-secret'
  });
  assert.match(result.checkoutUrl, /token=/);
  assert.doesNotMatch(security.sanitize(result).checkoutUrl, /token=/);
  assert.equal(
    security.sanitizeResult({
      data: { billingPageUrl: 'https://chatgpt.com/#settings/Subscription' }
    }).data.billingPageUrl,
    'https://chatgpt.com/#settings/Subscription'
  );
  assert.doesNotMatch(
    security.sanitizeResult({ data: { billingPageUrl: 'https://chatgpt.com/#synthetic-secret' } })
      .data.billingPageUrl,
    /synthetic-secret/
  );
});
test('operational logs preserve business identity, full IP, amounts and durations', () => {
  const taskId = '12345678-1234-4567-8def-123456789012';
  security.rememberSecrets({ jobKey: taskId, card_cvc: '123', accessToken: 'synthetic-token' });
  const business = `${taskId} fixture@example.invalid 8.8.8.123 PHP 9990.00 Timeout 29983.123456789ms`;
  assert.equal(security.redactText(business), business);
  const credentials = security.redactText('cvc=123 token=synthetic-token 4242424242424242');
  assert.doesNotMatch(credentials, /123|synthetic-token|4242424242424242/);
});
test('worker concurrency uses runtime capacity and optional environment hard cap', () => {
  const { capacity, childEnvironment } = require('../worker.cjs');
  assert.equal(capacity({ maxConcurrent: 2 }, {}), 2);
  assert.equal(capacity({ maxConcurrent: 3 }, { ONLINE_RECHARGE_WORKER_CONCURRENCY: '2' }), 2);
  assert.equal(capacity({ maxConcurrent: 1 }, { ONLINE_RECHARGE_WORKER_CONCURRENCY: '5' }), 1);
  process.env.DATABASE_URL = 'synthetic-db-secret';
  const env = childEnvironment(task());
  delete process.env.DATABASE_URL;
  assert.equal(env.DATABASE_URL, undefined);
  assert.match(env.ONLINE_RECHARGE_MEDIA_DIR, /synthetic-task$/);
});
test('browser management validation failure does not become an unknown payment', async () => {
  let finish;
  rpc.setTransportForTest(async (method, args) => {
    if (method === 'failJob') finish = args;
    return { ok: true };
  });
  await require('../worker.cjs').runJob(
    {
      ...task(),
      operation: 'browser_manage',
      payload: { action: 'invalid' },
      leaseExpiresAt: new Date(Date.now() + 90000).toISOString()
    },
    { browserPool: { enabled: false, size: 2 } }
  );
  assert.equal(finish.status, 'failed');
  assert.equal(finish.result.resultUnknown, undefined);
});
test('runtime and media paths reject relative, foreign-project and traversal outputs', () => {
  const { resolveProjectPath } = require('../paths.cjs');
  const fallback = path.join(__dirname, '..', 'runtime');
  assert.equal(resolveProjectPath('', fallback), fallback);
  assert.throws(() => resolveProjectPath('runtime', fallback));
  assert.throws(() => resolveProjectPath('/tmp/foreign-project', fallback));
  assert.throws(() =>
    resolveProjectPath(
      path.join(__dirname, '..', '../../../../../../../../../../outside'),
      fallback
    )
  );
});
test('real-page screenshots require masks and never fall back to raw capture', async () => {
  const media = require('../safe-media.cjs');
  const dir = path.join(__dirname, '..', 'runtime', `media-test-${process.pid}`);
  process.env.ONLINE_RECHARGE_MEDIA_DIR = dir;
  process.env.ONLINE_RECHARGE_FFMPEG_PATH = '/nonexistent/synthetic-ffmpeg';
  let options;
  let captureCalls = 0;
  const page = {
    evaluate: async (callback) => (String(callback).includes('document.fonts') ? true : undefined),
    locator: (selector) => {
      assert.match(selector, /cc-number/);
      assert.doesNotMatch(selector, /input,textarea|iframe/);
      return { selector };
    },
    screenshot: async (input) => {
      captureCalls++;
      options = input;
      return Buffer.from('synthetic-redacted-image');
    }
  };
  await media.start();
  await media.screenshot(page);
  const files = await media.finish();
  assert.equal(options.path, undefined);
  assert.equal(options.mask.length, 1);
  assert.equal(files.length, 1);
  await media.start();
  const failure = {
    ...page,
    evaluate: async (callback) => {
      if (String(callback).includes('document.fonts')) return true;
      throw new Error('synthetic page unavailable');
    }
  };
  assert.equal(await media.screenshot(failure), null);
  assert.equal(captureCalls, 1, 'failed masking must never produce another raw or masked image');
  assert.deepEqual(await media.finish(), []);
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.ONLINE_RECHARGE_MEDIA_DIR;
  delete process.env.ONLINE_RECHARGE_FFMPEG_PATH;
});
test('private CVC service returns availability only, binds task ownership, clears on completion', async () => {
  const credentials = require('../credentials.cjs');
  const key = 'synthetic-internal-key-at-least-32-characters';
  const service = await credentials.start({ url: 'http://127.0.0.1:0', key });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const post = async (route, body, auth = key) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-online-recharge-worker': auth },
      body: JSON.stringify(body)
    });
  try {
    assert.equal(
      (await post('/credentials', { cards: [{ id: card().id, cvc: '123' }] }, 'wrong')).status,
      401
    );
    assert.equal(
      (await post('/credentials', { cards: [{ id: card().id, cvc: '123' }] })).status,
      200
    );
    const status = await (await post('/credentials/status', { ids: [card().id] })).json();
    assert.deepEqual(status, { availableIds: [card().id] });
    assert.equal(status.cvc, undefined);
    assert.equal(credentials.take(card().id, 'task-a'), '123');
    assert.equal(credentials.take(card().id, 'task-b'), '');
    assert.equal(
      (await post('/credentials', { cards: [{ id: card().id, cvc: '456' }] })).status,
      409
    );
    credentials.forgetTask('task-a');
    assert.deepEqual(await (await post('/credentials/status', { ids: [card().id] })).json(), {
      availableIds: []
    });
  } finally {
    await service.close();
  }
});

for (const response of [
  { order_id: 'other-order', task_id: 'provider-task' },
  { order_id: 'provider-order', task_id: 'other-task' },
  {}
])
  test(`third party failed response must identify the original order: ${JSON.stringify(response)}`, async () => {
    rpc.configureTask(task());
    rpc.setTransportForTest(async () => ({ ok: true }));
    const fixture = thirdFixture('failed');
    let releases = 0;
    let declines = 0;
    fixture.injected.beforeSubmit = rpc.beforeExternalSubmit;
    fixture.injected.store.releaseCard = async () => {
      releases++;
    };
    fixture.injected.store.recordCardDecline = async () => {
      declines++;
    };
    fixture.injected.client.queryTask = async () => ({
      success: true,
      rawStatus: 'failed',
      data: { ...response, result: { ok: false, error: 'card_declined' } }
    });
    const result = await executeThirdParty(
      task(),
      { gptApi: {}, gptApiMaxPolls: 1 },
      fixture.injected
    );
    assert.equal(result.resultUnknown, true);
    assert.notEqual(result.definitiveFailure, true);
    assert.equal(fixture.calls.submit, 1);
    assert.equal(fixture.calls.reserve, 1);
    assert.equal(fixture.calls.usage, 0);
    assert.equal(releases, 0);
    assert.equal(declines, 0);
    assert.equal(rpc.wasSubmitted(), true);
  });

test('a matching original supplier failure remains a definitive failure', async () => {
  const fixture = thirdFixture('failed');
  fixture.injected.client.queryTask = async () => ({
    success: true,
    rawStatus: 'failed',
    data: { order_id: 'provider-order', task_id: 'provider-task', result: { ok: false } }
  });
  const result = await executeThirdParty(
    task(),
    { gptApi: {}, gptApiMaxPolls: 1 },
    fixture.injected
  );
  assert.equal(result.definitiveFailure, true);
  assert.notEqual(result.resultUnknown, true);
  assert.equal(fixture.calls.submit, 1);
});

for (const data of [{}, { order_id: 'other-order' }, { task_id: 'other-task' }])
  test(`recheck cannot release an original order without matching identity: ${JSON.stringify(data)}`, async () => {
    const t = {
      ...task(),
      payload: {
        recheckTaskId: 'original',
        originalProvider: 'third_party',
        providerOrderId: 'original-order',
        providerTaskId: 'original-task'
      }
    };
    let subscriptionReads = 0;
    const result = await recheck(
      t,
      {},
      {
        client: { queryTask: async () => ({ success: true, rawStatus: 'failed', data }) },
        query: async () => {
          subscriptionReads++;
          return { ok: true, data: {} };
        }
      }
    );
    assert.equal(result.resultUnknown, true);
    assert.notEqual(result.definitiveFailure, true);
    assert.equal(subscriptionReads, 0);
  });

for (const result of [
  { allowed: false, alreadyActive: true, error: 'Synthetic already active' },
  { allowed: false, alreadyActive: false, error: 'Synthetic account mismatch' }
])
  test(`third party cannot submit for failed subscription preflight: ${result.alreadyActive}`, async () => {
    const fixture = thirdFixture('success');
    fixture.injected.preflight = async () => result;
    const out = await executeThirdParty(task(), { gptApi: {} }, fixture.injected);
    assert.equal(out.success, false);
    assert.equal(out.submitted, false);
    assert.equal(out.alreadyActive, result.alreadyActive);
    assert.equal(fixture.calls.submit, 0);
    assert.equal(fixture.calls.reserve, 0);
    assert.equal(fixture.calls.billing, 0);
  });
