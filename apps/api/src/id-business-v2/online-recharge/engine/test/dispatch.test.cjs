'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rpc = require('../rpc.cjs');
const { execute } = require('../task-runner.cjs');
const hcaptcha = require('../upstream/hcaptcha-solver');
const platform = require('../upstream/captcha-platform');
const gpt = require('../upstream/gpt-api-client');
const telegram = require('../upstream/telegram-notify');
const proxies = require('../upstream/proxy-pool');
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
    return { ok: true, ip: '192.0.2.10', latencyMs: 12 };
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
    assert.equal(args.ip, '192.0.2.10');
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
