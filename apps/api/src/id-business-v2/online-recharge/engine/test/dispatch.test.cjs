'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const rpc = require('../rpc.cjs');
const { execute } = require('../task-runner.cjs');
const hcaptcha = require('../upstream/hcaptcha-solver');
const platform = require('../upstream/captcha-platform');
const gpt = require('../upstream/gpt-api-client');
const telegram = require('../upstream/telegram-notify');
const proxies = require('../proxy-test.cjs');
const cfg = {
  hcaptcha: {
    platform_api_key: 'synthetic-platform-key',
    platform_api_url: 'https://example.invalid'
  },
  gptApi: { api_key: 'synthetic-api-key' },
  telegram: {}
};
const calls = [];
const originals = [];
function stub(module, name, fn) {
  originals.push([module, name, module[name]]);
  module[name] = fn;
}
test.before(() => {
  stub(hcaptcha, 'checkHcaptchaSolverHealth', async () => {
    calls.push('solver');
    return { ready: true };
  });
  stub(hcaptcha, 'testVlmConnectivity', async (input) => {
    assert.equal(input, cfg.hcaptcha);
    calls.push('vlm');
    return { ok: true };
  });
  stub(platform, 'testCaptchaPlatformConnectivity', async (input) => {
    assert.equal(input.apiKey, cfg.hcaptcha.platform_api_key);
    calls.push('captcha_platform');
    return { ok: true };
  });
  stub(gpt, 'testConnection', async (input) => {
    assert.equal(input, cfg.gptApi);
    calls.push('gpt_api');
    return { success: true };
  });
  stub(gpt, 'fetchPlans', async () => {
    calls.push('plans');
    return { success: true, plans: ['synthetic-plan'] };
  });
  stub(gpt, 'queryBalance', async () => {
    calls.push('balance');
    return { success: true, balanceUsd: '10.00' };
  });
  stub(telegram, 'sendTelegramTest', async (store) => {
    assert.equal(await store.getTelegramConfig(), cfg.telegram);
    calls.push('telegram');
    return { success: true };
  });
  stub(telegram, 'dispatchTelegramNotification', async (_, event, payload) => {
    calls.push({ event, payload });
    return { sent: 1 };
  });
  stub(proxies, 'testProxyUrl', async (url) => {
    assert.equal(url, 'http://synthetic.invalid:1234');
    calls.push('proxy-connectivity');
    return { ok: true, ip: '8.8.8.8', latencyMs: 12 };
  });
});
test.after(() => {
  for (const [module, name, value] of originals) module[name] = value;
  rpc.setTransportForTest(null);
});
for (const target of ['solver', 'vlm', 'captcha_platform', 'gpt_api', 'telegram'])
  test(`configuration dispatch ${target} executes its original capability`, async () => {
    const start = calls.length;
    const result = await execute(
      { operation: 'config_test', payload: { target }, session: '{}' },
      cfg
    );
    assert.equal(result.success ?? result.ok ?? result.ready, true);
    assert.deepEqual(calls.slice(start), [target]);
  });
test('gpt_status dispatch executes both original plans and balance queries', async () => {
  const start = calls.length;
  const result = await execute(
    { operation: 'config_test', payload: { target: 'gpt_status' }, session: '{}' },
    cfg
  );
  assert.deepEqual(calls.slice(start).sort(), ['balance', 'plans']);
  assert.equal(result.balance.balanceUsd, '10.00');
  assert.deepEqual(result.plans.plans, ['synthetic-plan']);
});
test('solver_logs dispatch reads permission-scoped stored diagnostic events', async () => {
  let method;
  rpc.setTransportForTest(async (name, args) => {
    method = name;
    assert.equal(args.limit, 50);
    return { success: true, logs: [{ stage: 'hcaptcha', message: 'synthetic masked diagnostic' }] };
  });
  const result = await execute(
    { operation: 'config_test', payload: { target: 'solver_logs', limit: 50 }, session: '{}' },
    cfg
  );
  assert.equal(method, 'getSolverLogs');
  assert.equal(result.logs.length, 1);
});
test('proxy dispatch retrieves real connection transiently and reports tested resource', async () => {
  const methods = [];
  rpc.setTransportForTest(async (method, args) => {
    methods.push(method);
    if (method === 'getActiveProxy') {
      assert.equal(args.proxyId, 'synthetic-proxy');
      return { proxy_url: 'http://synthetic.invalid:1234' };
    }
    assert.equal(args.proxyId, 'synthetic-proxy');
    assert.equal(args.ip, '8.8.8.8');
    return { ok: true };
  });
  const result = await execute(
    { operation: 'proxy_test', payload: { ids: ['synthetic-proxy'] }, session: '{}' },
    cfg
  );
  assert.equal(result.success, true);
  assert.deepEqual(methods, ['getActiveProxy', 'proxyTestResult']);
  assert.equal(calls.at(-1), 'proxy-connectivity');
});
test('host login, password failure and MFA failure dispatch original safe notification events', async () => {
  for (const event of ['admin_login_success', 'admin_login_failed', 'admin_2fa_failed']) {
    const result = await execute(
      {
        id: 'synthetic-event',
        operation: 'notification',
        payload: {
          event,
          maskedIp: '192.0.*.*',
          email: 'never-forward@example.invalid',
          password: 'never-forward'
        }
      },
      cfg
    );
    assert.equal(result.sent, 1);
    assert.equal(calls.at(-1).event, event);
    assert.equal(calls.at(-1).payload.ip, '192.0.*.*');
    assert.equal(calls.at(-1).payload.email, undefined);
    assert.equal(calls.at(-1).payload.password, undefined);
  }
  await assert.rejects(() =>
    execute({ operation: 'notification', payload: { event: 'send_login_otp' } }, cfg)
  );
});

function queryModeDispatchFixture() {
  const observed = [];
  const primaryFailure = {
    ok: false,
    errorCode: 'SESSION_INVALID',
    compareDiagnostics: [
      { httpStatus: 200, accountFactsPresent: true, accountIdentityMatches: true }
    ]
  };
  const record =
    (kind) =>
    async (...args) => {
      observed.push({ kind, args });
      return primaryFailure;
    };
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(path.join(__dirname, '../task-runner.cjs'), 'utf8'), {
    module,
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === './security.cjs') return {};
      if (name === './rpc.cjs') return { wasSubmitted: () => false, recordKnownOutcome() {} };
      if (name === './upstream/mysql-store') return {};
      if (name === './upstream/session-auth')
        return { extractAccessTokenFromRaw: () => 'synthetic-mode-token' };
      if (name === './upstream/subscription-check')
        return {
          querySubscriptionBySession: record('subscription'),
          resumeAutoRenew: record('renewal-enable'),
          cancelAutoRenew: record('renewal-disable')
        };
      if (name === './upstream/index') return { run: record('payment') };
      if (name === './confirmation.cjs') return { recheck: record('recheck') };
      if (name === './third-party.cjs') return { executeThirdParty: record('third-party') };
      throw new Error(`Unexpected isolated dispatch import: ${name}`);
    }
  });
  return { execute: module.exports.execute, observed, primaryFailure };
}

test('only an explicit standalone subscription forwards comparison mode and preserves its primary failure', async () => {
  const f = queryModeDispatchFixture();
  for (const mode of ['transport_compare', undefined, 'unsupported']) {
    const result = await f.execute(
      {
        operation: 'subscription',
        session: 'synthetic-session',
        payload: { queryTransportMode: mode }
      },
      {}
    );
    const call = f.observed.at(-1);
    assert.equal(call.kind, 'subscription');
    assert.equal(call.args[1].queryTransportMode, mode === 'transport_compare' ? mode : undefined);
    assert.equal(result, f.primaryFailure);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'SESSION_INVALID');
  }
});

for (const [operation, action, expected] of [
  ['renewal', 'check', 'subscription'],
  ['renewal', 'enable', 'renewal-enable'],
  ['renewal', 'disable', 'renewal-disable'],
  ['recharge', undefined, 'payment'],
  ['debug', undefined, 'payment']
])
  test(`${operation}/${action || 'run'} does not forward comparison mode into its execution options`, async () => {
    const f = queryModeDispatchFixture();
    await f.execute(
      {
        operation,
        session: 'synthetic-session',
        payload: { queryTransportMode: 'transport_compare', action }
      },
      {}
    );
    const call = f.observed[0];
    assert.equal(call.kind, expected);
    const options = expected === 'payment' ? call.args[0] : call.args[1];
    assert.equal(Object.hasOwn(options, 'queryTransportMode'), false);
    assert.equal(f.observed.length, 1);
  });

test('original-order subscription recheck stays in reconciliation and does not receive comparison options', async () => {
  const f = queryModeDispatchFixture();
  const result = await f.execute(
    {
      operation: 'subscription',
      session: 'synthetic-session',
      payload: {
        recheckTaskId: 'synthetic-original-order',
        queryTransportMode: 'transport_compare'
      }
    },
    {}
  );
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].kind, 'recheck');
  assert.equal(Object.hasOwn(f.observed[0].args[2], 'queryTransportMode'), false);
  assert.equal(result, f.primaryFailure);
});

test('third-party recharge never invokes subscription comparison or forwards it as provider options', async () => {
  const f = queryModeDispatchFixture();
  await f.execute(
    {
      operation: 'recharge',
      provider: 'third_party',
      payload: { queryTransportMode: 'transport_compare' }
    },
    {}
  );
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].kind, 'third-party');
  assert.equal(Object.hasOwn(f.observed[0].args[2], 'queryTransportMode'), false);
});

test('successful comparison facts never become subscription confirmation or payment authorization', async () => {
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(path.join(__dirname, '../confirmation.cjs'), 'utf8'), {
    module,
    process: { env: {} },
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === './plans.cjs') return require('../plans.cjs');
      if (name === './rpc.cjs') return { wasSubmitted: () => false };
      if (name === './upstream/session-auth')
        return { extractProfileFromToken: () => ({ accountId: 'synthetic-account' }) };
      throw new Error(`Unexpected isolated confirmation import: ${name}`);
    }
  });
  let queryCalls = 0;
  const result = {
    ok: false,
    errorCode: 'NETWORK_TIMEOUT',
    compareDiagnostics: [
      { httpStatus: 200, accountFactsPresent: true, accountIdentityMatches: true }
    ],
    data: {
      upstreamAccountId: 'synthetic-account',
      hasActiveSubscription: false,
      rawPlan: 'free'
    }
  };
  const confirmation = module.exports.evaluateSubscription('pro_20x', 'synthetic-account', result);
  assert.equal(confirmation.verified, false);
  assert.equal(confirmation.querySucceeded, false);
  const preflight = await module.exports.preflightPayment('pro_20x', 'synthetic-mode-token', {
    query: async () => {
      queryCalls++;
      return result;
    }
  });
  assert.equal(preflight.allowed, false);
  assert.equal(preflight.alreadyActive, false);
  assert.equal(preflight.confirmation.queryErrorCode, 'NETWORK_TIMEOUT');
  assert.equal(queryCalls, 1);
});
