'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const control = require('../rpc.cjs');
const security = require('../security.cjs');

test('an accepted payment cannot be submitted again through the local RPC path', async () => {
  control.configureTask({ id: 'synthetic-task' });
  let submissions = 0;
  control.setTransportForTest(async (method) => {
    if (method === 'beforeExternalSubmit') submissions++;
    return { ok: true };
  });
  try {
    await control.beforeExternalSubmit({ paymentContext: { amount: '10.00', currency: 'PHP' } });
    await assert.rejects(control.beforeExternalSubmit(), { code: 'RESULT_UNKNOWN' });
    assert.equal(submissions, 1);
  } finally {
    control.setTransportForTest(null);
    control.clearTask();
  }
});

test('task cancellation aborts active work and cannot affect the next task', async () => {
  control.configureTask({ id: 'cancelled-task' });
  const oldSignal = control.taskSignal();
  let cancelled = false;
  oldSignal.addEventListener(
    'abort',
    () => {
      cancelled = true;
    },
    { once: true }
  );
  control.abortTask(new control.LeaseLostError());
  assert.equal(cancelled, true);
  await assert.rejects(control.rpc('getRuntimeConfig'), { code: 'LEASE_LOST' });
  control.clearTask();
  control.configureTask({ id: 'next-task' });
  assert.equal(control.taskSignal().aborted, false);
  assert.notEqual(control.taskSignal(), oldSignal);
  control.clearTask();
});

test('checkout recovery capability never appears in ordinary results or logs', () => {
  const recovery = {
    checkoutId: 'oaics_synthetic_recovery_identifier',
    checkoutUrl: 'https://chatgpt.com/checkout/test/oaics_synthetic_recovery_identifier'
  };
  security.rememberSecrets(recovery);
  try {
    const result = security.sanitizeResult({
      checkoutRecovery: recovery,
      checkoutRecoveryEncrypted: 'synthetic-cipher',
      amount: '10.00',
      currency: 'PHP'
    });
    assert.equal(result.checkoutRecovery, '[已隐藏]');
    assert.equal(result.checkoutRecoveryEncrypted, '[已隐藏]');
    assert.equal(result.amount, '10.00');
    assert.ok(!security.redactText(recovery.checkoutId).includes(recovery.checkoutId));
    const debug = security.sanitizeResult({ debugOnly: true, checkoutUrl: recovery.checkoutUrl });
    assert.equal(debug.checkoutUrl, recovery.checkoutUrl);
  } finally {
    security.clearSecrets();
  }
});

function cancelledRunnerFixture({ execute, notify = async () => {} }) {
  const messages = [],
    notifications = [];
  let controller = new AbortController(),
    cleaned = 0;
  const taskControl = {
    configureTask() {
      controller = new AbortController();
    },
    clearTask() {},
    wasSubmitted: () => false,
    wasPaymentConfirmed: () => false,
    taskSignal: () => controller.signal,
    abortTask: () => controller.abort(),
    rpc: async (method) => (method === 'getRuntimeConfig' ? { hcaptcha: {}, telegram: {} } : {})
  };
  const module = { exports: {} };
  runInNewContext(fs.readFileSync(path.join(__dirname, '../task-runner.cjs'), 'utf8'), {
    module,
    __dirname: path.join(__dirname, '..'),
    setTimeout,
    console: { log() {}, error() {}, warn() {} },
    process: { env: {}, connected: true, send: (value) => messages.push(value) },
    require(name) {
      if (name === 'node:path') return path;
      if (name === './rpc.cjs') return taskControl;
      if (name === './security.cjs')
        return {
          rememberSecrets() {},
          installSafeConsole() {},
          sanitizeResult: (value) => value,
          clearSensitive() {},
          clearSecrets() {}
        };
      if (name === './upstream/mysql-store')
        return { getActiveProxy: async () => '', clearCredentials: () => cleaned++ };
      if (name === './upstream/session-auth') return { extractAccessTokenFromRaw: () => '' };
      if (name === './upstream/hcaptcha-runtime')
        return { buildHcaptchaEnvFromConfig: () => ({ env: {} }) };
      if (name === './upstream/index') return { run: () => execute(taskControl) };
      if (name === './upstream/telegram-notify')
        return {
          dispatchTelegramNotification: async (...args) => {
            notifications.push(args);
            return notify(taskControl);
          }
        };
      throw new Error('Unexpected synthetic import ' + name);
    }
  });
  return {
    messages,
    notifications,
    abort: () => taskControl.abortTask(),
    cleaned: () => cleaned,
    run: () =>
      module.exports.runTask({
        id: 'synthetic-cancellation',
        operation: 'recharge',
        provider: 'local',
        plan: 'plus',
        payload: {}
      })
  };
}

test('a recharge that swallows cancellation and returns failure emits no business result or notification', async () => {
  const fixture = cancelledRunnerFixture({
    execute: async (control) => {
      control.abortTask();
      return { success: false, resultUnknown: false, error: 'synthetic cancellation' };
    }
  });
  await fixture.run();
  assert.equal(
    fixture.messages.some((item) => item.type === 'result'),
    false
  );
  assert.equal(fixture.notifications.length, 0);
  assert.equal(fixture.cleaned(), 1);
});

test('cancellation during asynchronous notification cannot send a guessed business outcome', async () => {
  let releaseNotification, notificationStarted;
  const started = new Promise((resolve) => {
    notificationStarted = resolve;
  });
  const pending = new Promise((resolve) => {
    releaseNotification = resolve;
  });
  const fixture = cancelledRunnerFixture({
    execute: async () => ({ success: false, resultUnknown: false }),
    notify: async () => {
      notificationStarted();
      await pending;
    }
  });
  const running = fixture.run();
  await started;
  fixture.abort();
  releaseNotification();
  await running;
  assert.equal(fixture.notifications.length, 1);
  assert.equal(
    fixture.messages.some((item) => item.type === 'result'),
    false
  );
  assert.equal(fixture.cleaned(), 1);
});
