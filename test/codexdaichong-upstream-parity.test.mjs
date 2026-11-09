import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
});
after(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

test('all 203 upstream files match: 199 original and four precisely reviewed routing and return boundaries', async () => {
  const result = await verifyCodexdaichongSource(prepared);
  assert.equal(result.revision, CODEXDAICHONG_REVISION);
  assert.equal(result.files, 203);
  await exec(process.execPath, ['--check', join(prepared, 'server.js')]);
  await exec(process.execPath, ['--check', join(prepared, 'mysql-store.js')]);
  assert.equal(result.originalFiles, 199);
  assert.deepEqual(result.routingFiles, ['pricing-checkout.js', 'region-config.js', 'server.js']);
  assert.deepEqual(result.returnFiles, ['mysql-store.js', 'server.js']);
  assert.equal((await readFile(join(prepared, 'mysql-store.js'), 'utf8')).replace('module.exports = {\n    withTransaction,', 'module.exports = {'), await original('mysql-store.js'), '事务导出不改变任何原版数据库函数');
  for (const name of ['index.js', 'payment-retry.js', 'stripe-payment.js',
    'tax-free-address.js', 'package-lock.json'])
    assert.equal(await readFile(join(prepared, name), 'utf8'), await original(name), name);
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
  const module = { exports: {} };
  const dependencies = {
    './mysql-store': {
      getPaymentRegion: async () => 'MY', getAppConfigValue: async () => null,
      reserveCard: async () => {
        calls.push('reserve');
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
  const result = await module.exports.executePaymentWithRetry({}, { planType: 'plus', cdkCode: 'synthetic-code' });
  assert.equal(result.success, false);
  assert.equal(result.manualIntervention, true);
  return calls;
}

test('all callers retain native card rotation, including an obsolete Vendure flag', async () => {
  const baseline = await declinedCardAttempts(await original('payment-retry.js'), false);
  const integratedSource = await readFile(join(prepared, 'payment-retry.js'), 'utf8');
  const ordinary = await declinedCardAttempts(integratedSource, false);
  assert.deepEqual(ordinary, baseline);
  assert.equal(ordinary.filter((call) => call === 'attempt').length, 4);
  const vendure = await declinedCardAttempts(integratedSource, true);
  assert.deepEqual(vendure, baseline);
  assert.equal(vendure.filter((call) => call === 'attempt').length, 4);
});
