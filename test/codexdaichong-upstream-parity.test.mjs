import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { CODEXDAICHONG_REVISION, prepareCodexdaichong, verifyCodexdaichongSource } from '../modules/recharge/codexdaichong/prepare.mjs';

const exec = promisify(execFile);
const upstream = fileURLToPath(new URL('../.upstream/codexdaichong/', import.meta.url));
const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
let fixture;
let prepared;
let previous;
const quiet = { log() {}, warn() {}, error() {} };

async function original(file) {
  return (await exec('git', ['-C', upstream, 'show', CODEXDAICHONG_REVISION + ':' + file], {
    maxBuffer: 2 * 1024 * 1024
  })).stdout;
}

before(async () => {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  fixture = await mkdtemp(join(runtime, 'upstream-parity-'));
  prepared = await prepareCodexdaichong(join(fixture, 'engine'));
  previous = join(fixture, 'before-provider-retirement');
  await mkdir(previous);
  await Promise.all(['server.js', 'mysql-store.js', 'payment-retry.js'].map(name => copyFile(join(prepared, name), join(previous, name))));
  for (const patch of ['card-plans/upstream-card-plans.patch', 'provider-retirement/upstream-provider-retirement.patch']) {
    const path = fileURLToPath(new URL('../modules/recharge/codexdaichong/' + patch, import.meta.url));
    await exec('git', ['--git-dir=' + join(upstream, '.git'), '--work-tree=' + previous, 'apply', '--reverse', path], { cwd: previous });
  }
});
after(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

test('all 203 upstream files match the original and four exact patches', async () => {
  const result = await verifyCodexdaichongSource(prepared);
  assert.equal(result.revision, CODEXDAICHONG_REVISION);
  assert.equal(result.files, 203);
  await exec(process.execPath, ['--check', join(prepared, 'server.js')]);
  await exec(process.execPath, ['--check', join(prepared, 'mysql-store.js')]);
  assert.equal(result.originalFiles, 198);
  assert.deepEqual(result.routingFiles, ['pricing-checkout.js', 'region-config.js', 'server.js']);
  assert.deepEqual(result.returnFiles, ['mysql-store.js', 'server.js']);
  assert.deepEqual(result.providerRetirementFiles, ['mysql-store.js', 'server.js']);
  assert.deepEqual(result.cardPlanFiles, ['mysql-store.js', 'payment-retry.js', 'server.js']);
  const mysql = await readFile(join(prepared, 'mysql-store.js'), 'utf8');
  const previousMysql = await readFile(join(previous, 'mysql-store.js'), 'utf8');
  assert.equal(previousMysql.replace('module.exports = {\n    withTransaction,', 'module.exports = {'), await original('mysql-store.js'));
  for (const [start, end] of [
    ['async function markCdkUsed(', 'async function deletePhoneAsset('],
    ['async function releaseCard(', 'async function importCards(']
  ]) assert.equal(section(mysql, start, end), section(previousMysql, start, end), start);
  for (const name of ['index.js', 'stripe-payment.js',
    'tax-free-address.js', 'package-lock.json'])
    assert.equal(await readFile(join(prepared, name), 'utf8'), await original(name), name);
  assert.equal((await readFile(join(prepared, 'payment-retry.js'), 'utf8'))
    .replace('store.reserveCard(ownerKey, planType)', 'store.reserveCard(ownerKey)'), await original('payment-retry.js'));
});

test('a tampered core file is rejected even when the revision marker is unchanged', async () => {
  const path = join(prepared, 'index.js');
  const baseline = await readFile(path);
  try {
    await writeFile(path, Buffer.concat([baseline, Buffer.from('\n// injected patch\n')]));
    await assert.rejects(verifyCodexdaichongSource(prepared), /原版充值文件被改写：index.js/);
  } finally { await writeFile(path, baseline); }
});

function section(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'pinned worker boundary must remain identifiable');
  return source.slice(start, end);
}

async function submitTrace(source, { plan = 'plus', state = 'ready', providerEnabled = false } = {}) {
  const calls = [];
  let providerReads = 0;
  let checkedPlan;
  const cdk = { type: '自助', plan_type: plan };
  const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  const req = { path: '/api/run-process', body: { cdk: 'synthetic-code', session: '{"accessToken":"fixture"}' } };
  const store = {
    getMaintenanceModeState: async () => ({ enabled: state === 'maintenance' }),
    getMaxConcurrentActivations: async () => 2,
    verifyCdkDetails: async () => state === 'invalid-code' ? null : cdk,
    getRunningTaskByCdk: async () => state === 'running' ? { job_key: 'earlier-job', message: '已受理' } : null,
    getActivationManualHold: async () => state === 'review',
    getGptApiConfig: async () => { providerReads++; return { enabled: providerEnabled, api_key: 'fixture' }; },
    hasAvailableCard: async plan => { checkedPlan = plan; calls.push('cards'); return state !== 'no-card'; },
    markCdkUsed: async () => { calls.push('lock-code'); return state !== 'locked-code'; },
    markCdkUnused: async () => { calls.push('release-code'); },
    createTaskLog: async data => { calls.push(['task', data]); return { jobKey: 'new-job' }; }
  };
  const handler = section(source, 'async function handleActivationRequest(', "app.post('/api/run-process'");
  await runInNewContext(handler + '\nhandleActivationRequest(req, res)', {
    req, res, store, console: quiet, activeForegroundJobs: new Set(),
    parseSessionJson: JSON.parse, normalizeSessionToken: () => 'fixture', validateAccessToken: () => ({ valid: true }),
    getClientIp: () => '', requireReadablePlanType: value => value, getRemainingCooldownMinutes: () => 0,
    ensureStoreReady: async () => {}, sanitizeCustomerTaskMessage: value => value,
    getRechargeRouting: async () => ({ async resolve(planType) {
      calls.push(['route', planType]);
      if (state === 'no-route') throw new Error('fixture route unavailable');
      return { region: ['plus', 'pro200'].includes(planType) ? 'PH' : 'EG', proxy: 'fixture-route' };
    } }),
    extractEmailFromSession: () => 'fixture@example.test',
    fireTelegramNotification: (event) => calls.push(event),
    buildStoredSessionPayload: value => value, extractSessionPreview: () => 'fixture',
    reserveForegroundSlot: key => calls.push(['slot', key]),
    spawnActivationWorker: options => calls.push(['native', options]),
    runGptApiWorker: async () => calls.push('third-party'),
    logTask: (key, message) => calls.push(['log', key, message])
  });
  return { providerReads, checkedPlan, result: JSON.parse(JSON.stringify({ code: res.code, data: res.data, calls })) };
}

test('removing the provider preserves native admission and dispatch even with stale enabled settings', async () => {
  const [baseline, candidate] = await Promise.all([previous, prepared].map(dir => readFile(join(dir, 'server.js'), 'utf8')));
  for (const [start, end] of [
    ['function spawnCheckoutDebugWorker(', "const LEGACY_PROVIDER_FAILURE_MESSAGE"],
    ['function spawnActivationWorker(', 'async function handleActivationRequest(']
  ]) {
    const oldEnd = start.includes('CheckoutDebug') ? '/**\n * 第三方 GPT' : end;
    assert.equal(section(candidate, start, end), section(baseline, start, oldEnd), start);
  }
  const previousProvider = await submitTrace(baseline, { providerEnabled: true });
  assert(previousProvider.result.calls.includes('third-party'));
  for (const options of [
    ...['plus', 'pro100', 'pro200', 'pro500'].map(plan => ({ plan })),
    ...['maintenance', 'invalid-code', 'running', 'review', 'no-route', 'locked-code'].map(state => ({ state }))
  ]) {
    const { result } = await submitTrace(baseline, options);
    const retired = await submitTrace(candidate, { ...options, providerEnabled: true });
    assert.equal(retired.providerReads, 0, JSON.stringify(options));
    assert.deepEqual(retired.result, result, JSON.stringify(options));
    if (options.plan) assert.equal(retired.checkedPlan, options.plan);
  }
  const blocked = await submitTrace(candidate, { plan: 'pro500', state: 'no-card' });
  assert.equal(blocked.checkedPlan, 'pro500');
  assert.equal(blocked.result.code, 503);
  assert.equal(blocked.result.data.code, 'recharge_plan_cards_unavailable');
  assert.equal(blocked.result.data.execution_started, false);
  assert.deepEqual(blocked.result.calls, [['route', 'pro500'], 'cards', 'card_pool_empty']);
  assert.doesNotMatch(candidate, /require\(['"]\.\/gpt-api-client|\/api\/(?:admin\/gpt-api|task-captcha)|runGptApiWorker/);
});

test('Orbitcard configuration remains usable without exposing saved credentials or accepting provider settings', async () => {
  const candidate = await readFile(join(prepared, 'server.js'), 'utf8');
  const adminAuth = createRequire(import.meta.url)(join(upstream, 'admin-auth.js'));
  const routes = new Map();
  const saved = {
    live_management: true, orbitcard_base_url: 'https://cards.example.test',
    orbitcard_api_key: 'saved-fixture-key', orbitcard_api_secret: 'saved-fixture-secret'
  };
  const writes = [];
  const route = '/api/admin/orbitcard/config';
  runInNewContext(
    section(candidate, 'const ORBITCARD_SECRET_TARGETS', "app.post('/api/admin/hcaptcha'") +
    section(candidate, "app.get('" + route, "app.get('/api/admin/orbitcard/products'"),
    {
      adminAuth, ensureStoreReady: async () => {},
      app: Object.fromEntries(['get', 'post'].map(method => [method, (path, fn) => routes.set(method + path, fn)])),
      store: {
        getOrbitcardConfig: async () => saved,
        saveOrbitcardConfig: async (fields, current) => { assert.equal(current, saved); writes.push(fields); }
      }
    }
  );
  async function call(method, body) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
    await routes.get(method + route)({ body }, res);
    return JSON.parse(JSON.stringify(res));
  }
  assert.deepEqual((await call('get')).data.config, {
    live_management: true, orbitcard_base_url: saved.orbitcard_base_url,
    orbitcard_api_key_saved: true, orbitcard_api_secret_configured: true
  });
  assert.equal((await call('post', { orbitcard_base_url: 'https://different.example.test' })).code, 400);
  assert.deepEqual(writes, []);
  assert.equal((await call('post', { live_management: false, enabled: true, api_key: 'retired-fixture-key' })).code, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ live_management: false }]);
});

async function checkoutPhase(source, { debugOnly, failApi = false, apiOnly = false }) {
  const calls = [];
  const checkoutUrl = 'https://chatgpt.com/checkout/openai_llc/oaics_synthetic';
  const sandbox = {
    console: quiet, process: { env: { CHECKOUT_MODE: 'api', CHECKOUT_API_ONLY: apiOnly ? '1' : '0' } },
    debugOnly, CONFIG: { planNameOverride: 'chatgptplusplan', chatgptToken: 'synthetic-token' },
    loginInfo: { session: { accessToken: 'synthetic-token' } },
    planType: 'plus', billingCountry: 'MY', billingCurrency: 'MYR',
    cdkCode: 'synthetic-code', email: 'fixture@example.test', context: {}, paymentSucceeded: false,
    page: { url: () => checkoutUrl }, sanitizeCheckoutDiagnostic: (value) => value,
    openApiCheckout: async (_page, options) => {
      calls.push(['api', options]);
      if (failApi) throw new Error('synthetic API rejection');
      return { checkoutUrl };
    },
    openPricingCheckout: async (_page, options) => { calls.push(['ui', options]); },
    verifyCheckoutDebugPage: async () => { calls.push(['verify']); return { checkoutUrl }; },
    captureDebugScreenshot: async () => { calls.push(['screenshot']); return 'synthetic.png'; },
    executePaymentWithRetry: async (_page, options) => {
      calls.push(['payment', options]);
      assert.equal(debugOnly, false, 'a debug job must never reach the payment implementation');
      return { success: true, screenshots: [] };
    }
  };
  const phase = section(source, '        // --- Phase 2: API 创建 Checkout',
    '    } catch (e) {\n        console.error("❌ [运行时错误]');
  let error;
  try {
    await runInNewContext(`(async () => { ${phase}\n })()`, sandbox);
  } catch (caught) {
    error = caught.message;
  }
  return JSON.parse(JSON.stringify({ calls, error }));
}

test('API-first checkout, same-region UI fallback and the no-payment debug stop match upstream', async () => {
  const originalWorker = await original('index.js');
  const integratedWorker = await readFile(join(prepared, 'index.js'), 'utf8');
  for (const scenario of [
    { debugOnly: true }, { debugOnly: true, failApi: true },
    { debugOnly: true, failApi: true, apiOnly: true },
    { debugOnly: false }, { debugOnly: false, failApi: true }
  ]) {
    const baseline = await checkoutPhase(originalWorker, scenario);
    const integrated = await checkoutPhase(integratedWorker, scenario);
    assert.deepEqual(integrated, baseline);
    const steps = integrated.calls.map(([name]) => name);
    if (scenario.apiOnly) {
      assert.deepEqual(steps, ['api']);
      assert.equal(integrated.error, 'synthetic API rejection');
      continue;
    }
    assert.equal(integrated.error, undefined);
    assert.deepEqual(steps, ['api', ...(scenario.failApi ? ['ui'] : []),
      ...(scenario.debugOnly ? ['verify', 'screenshot'] : ['payment'])]);
    assert.equal(integrated.calls[0][1].country, 'MY');
    assert.equal(integrated.calls[0][1].currency, 'MYR');
    assert.equal(integrated.calls[0][1].planType, 'plus');
    if (scenario.failApi)
      assert.deepEqual(integrated.calls[1], ['ui', { region: 'MY', planType: 'plus' }]);
  }
});

async function declinedCardAttempts(source, vendure) {
  const calls = [];
  const plans = [];
  const module = { exports: {} };
  const dependencies = {
    './mysql-store': {
      getPaymentRegion: async () => 'MY', getAppConfigValue: async () => null,
      reserveCard: async (_owner, plan) => {
        calls.push('reserve');
        plans.push(plan);
        return { id: calls.length, card_number: 'synthetic-0001', card_holder: 'Fixture' };
      },
      createBillingRecord: async () => { calls.push('record'); },
      markCardExhausted: async () => { calls.push('exhaust'); },
      releaseCard: async () => { calls.push('release'); }
    },
    './stripe-payment': {
      readCheckoutDueAmount: async () => ({ amount: 1, currency: 'MYR' }),
      completeStripeCardPayment: async () => {
        calls.push('attempt');
        return { success: false, declined: true, error: 'synthetic card_declined' };
      }
    },
    './tax-free-address': { pickBillingAddressForCheckout: async () => ({ generated: true }) },
    './region-config': { getRegionConfig: () => ({ currency: 'MYR' }) },
    './plan-registry': { requireReadablePlanType: (plan) => plan },
    './gpt-api-failure': { redactSensitiveText: (value) => value }
  };
  runInNewContext(source, {
    module, console: quiet,
    process: { env: { PAYMENT_MAX_CARD_ATTEMPTS: '4', ID_VENDURE_SINGLE_ATTEMPT: vendure ? '1' : '' } },
    require: (name) => { assert.ok(Object.hasOwn(dependencies, name)); return dependencies[name]; }
  });
  const result = await module.exports.executePaymentWithRetry({}, { planType: 'pro500', cdkCode: 'synthetic-code' });
  assert.equal(result.success, false);
  assert.equal(result.manualIntervention, true);
  return { calls, plans };
}

test('all callers retain native card rotation, including an obsolete Vendure flag', async () => {
  const baseline = await declinedCardAttempts(await original('payment-retry.js'), false);
  const integratedSource = await readFile(join(prepared, 'payment-retry.js'), 'utf8');
  const ordinary = await declinedCardAttempts(integratedSource, false);
  assert.deepEqual(ordinary.calls, baseline.calls);
  assert.equal(ordinary.calls.filter((call) => call === 'attempt').length, 4);
  assert.deepEqual(ordinary.plans, Array(4).fill('pro500'));
  const vendure = await declinedCardAttempts(integratedSource, true);
  assert.deepEqual(vendure.calls, baseline.calls);
  assert.deepEqual(vendure.plans, ordinary.plans);
});
