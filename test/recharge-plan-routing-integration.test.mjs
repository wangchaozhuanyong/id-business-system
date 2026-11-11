import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext, Script } from 'node:vm';
import { prepareCodexdaichong } from '../modules/recharge/codexdaichong/prepare.mjs';
import { loadCodexdaichongAssets } from '../modules/recharge/codexdaichong/assets.mjs';
import { createNativeRechargeRouting, DEFAULT_PLAN_ROUTES } from '../modules/recharge/codexdaichong/native-routing.mjs';

let fixture, server, assets;
before(async () => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true }); fixture = await mkdtemp(join(runtime, 'route-integration-'));
  server = await readFile(join(await prepareCodexdaichong(join(fixture, 'engine')), 'server.js'), 'utf8');
  assets = await loadCodexdaichongAssets();
});
after(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });
function section(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first); return source.slice(first, last);
}
test('failed selection returns before card availability, CDK locking or task creation', async () => {
  const calls = [];
  const routing = createNativeRechargeRouting({
    store: { async runQuery(sql) {
      if (sql.startsWith('SELECT version')) return [{ version: 1, plans_json: DEFAULT_PLAN_ROUTES, audit_json: [] }];
      if (sql.includes('FROM id_recharge_proxy_checks')) return [];
      assert.match(sql, /LEFT JOIN id_recharge_proxy_country_labels/);
      return [{ id: 1, proxy_url: 'socks5://proxy.example.test:1080', is_active: 1, label_country_code: 'MX' }];
    } },
    substituteSession: value => value,
    async probe() { calls.push('probe'); }
  });
  const phase = section(server, '        const gptApiConfig = await store.getGptApiConfig();\n        const useGptApi',
    '        const lockSuccess = await store.markCdkUsed(cdk);');
  let result;
  const res = { status(code) { result = { code }; return this; }, json(body) { result.body = body; return result; } };
  await runInNewContext('(async () => {' + phase + '\n})()', {
    res, planType: 'plus',
    store: { getGptApiConfig: async () => ({ enabled: false }), hasAvailableCard: async () => calls.push('card') },
    getRechargeRouting: async () => routing
  });
  assert.equal(result.code, 409); assert.equal(result.body.execution_started, false);
  assert.match(result.body.message, /联系客服/);
  assert.doesNotMatch(JSON.stringify(result), /proxy\.example|MX/);
  assert.deepEqual(calls, []);
});
test('debug worker passes the selected route and preserves all upstream api_only variants', async t => {
  for (const apiOnly of [undefined, false, true]) await t.test(String(apiOnly), async () => {
  const route = { proxy: 'socks5://synthetic-sticky', region: 'PH' };
  let actual, verifyCount = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const worker = section(server, 'function spawnCheckoutDebugWorker(', '/**\n * 第三方 GPT');
  const sandbox = {
    path: { join: (...parts) => parts.join('/') }, __dirname: '/synthetic',
    process: { env: { PROXY: 'wrong-global', PAYMENT_REGION_OVERRIDE: 'MY', CHECKOUT_API_ONLY: '1' } }, console: { error: finish },
    store: { getActiveProxy: async () => { throw new Error('must not select again'); },
      getHcaptchaConfig: async () => ({}), updateTaskLog: async (_key, result) => { if (result.status !== 'running') finish(); } },
    getRechargeRouting: async () => ({ describe: () => 'safe route', verifiedStart(selected, callback) {
      assert.equal(selected, route); return async env => { verifyCount++; return callback(env); };
    } }),
    buildHcaptchaEnvFromConfig: () => ({ env: {} }), logTask() {},
    spawnWorkerWithBrowser: async ({ runtimeEnv, runScript }) => { actual = runtimeEnv; return runScript(runtimeEnv); },
    runCheckoutScript: async () => ({ output: '', timedOut: false }),
    analyzeCheckoutDebugOutput: () => ({ status: 'success', checkoutPageReady: true }),
    extractCheckoutUrlFromOutput: () => '', extractScreenshotsFromOutput: () => []
  };
  runInNewContext(worker + '\nspawnCheckoutDebugWorker(input);', { ...sandbox,
    input: { task: { jobKey: 'synthetic' }, token: 'synthetic', sessionRaw: '{}', planType: 'plus',
      region: route.region, executionRoute: route, ...(apiOnly === undefined ? {} : { apiOnly }) } });
  await done;
  assert.equal(actual.PROXY, route.proxy); assert.equal(actual.PAYMENT_REGION_OVERRIDE, 'PH');
  assert.equal(actual.CHECKOUT_DEBUG_ONLY, '1'); assert.equal(actual.CHECKOUT_MODE, 'api');
  assert.equal(actual.CHECKOUT_API_ONLY, apiOnly === true ? '1' : '0'); assert.equal(verifyCount, 1);
  });
});

test('admin generate keeps the original optional api_only contract with the new routing dependency supplied', async () => {
  const original = await readFile(fileURLToPath(new URL('../.upstream/codexdaichong/server.js', import.meta.url)), 'utf8');
  async function invoke(source, apiOnly) {
    let handler, selected = 0;
    const spawned = [], created = [];
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; } };
    runInNewContext(section(source, "app.post('/api/admin/checkout/generate'", "app.get('/api/admin/checkout/status/:jobKey'"), {
      app: { post: (_path, callback) => { handler = callback; } }, ensureStoreReady: async () => {},
      parseSessionJson: JSON.parse, normalizeSessionToken: () => 'synthetic', validateAccessToken: () => ({ valid: true }),
      requireCanonicalPlanType: value => value, isSupportedRegion: value => value === 'PH',
      buildStoredSessionPayload: value => value, extractEmailFromSession: () => 'fixture@example.test',
      extractSessionPreview: () => 'synthetic', logTask() {},
      spawnCheckoutDebugWorker: value => spawned.push({ apiOnly: value.apiOnly, region: value.region }),
      getRechargeRouting: async () => ({ resolve: async () => { selected++; return { region: 'PH', proxy: '' }; } }),
      store: { resolvePlanName: () => 'chatgptplusplan', getPaymentRegion: async () => 'PH',
        createTaskLog: async value => { created.push(value.cdkCode); return { jobKey: 'synthetic' }; }, updateTaskLog: async () => {} }
    });
    await handler({ body: { session: '{"accessToken":"synthetic"}',
      ...(apiOnly === undefined ? {} : { api_only: apiOnly }) } }, response);
    return { status: response.statusCode, body: JSON.parse(JSON.stringify(response.body)), spawned, created, selected };
  }
  for (const value of [undefined, false, true, 'true', 'false', 1, null, {}]) {
    const { selected: originalSelected, ...baseline } = await invoke(original, value);
    const { selected, ...candidate } = await invoke(server, value);
    assert.deepEqual(candidate, baseline);
    assert.equal(originalSelected, 0);
    assert.equal(selected, value === undefined || typeof value === 'boolean' ? 1 : 0);
    if (candidate.status === 200) {
      assert.equal(candidate.spawned.length, 1); assert.equal(candidate.spawned[0].apiOnly, value === true);
      assert.deepEqual(candidate.created, ['[checkout-debug]']);
    } else { assert.equal(candidate.status, 400); assert.match(candidate.body.error, /api_only/); }
  }
});

async function activationTrace(source, analyses, integrated, failReselect = false) {
  const trace = [], runs = [], failures = [];
  let selected = 1, released;
  const finished = new Promise(resolve => { released = resolve; });
  const route = number => ({ planType: 'plus', region: 'PH', proxy: 'synthetic-proxy-' + number });
  const nativeStore = {
    getActiveProxy: async () => {
      if (failReselect && selected === 2) throw new Error('synthetic route unavailable');
      return route(selected++).proxy;
    },
    getHcaptchaConfig: async () => ({}),
    updateTaskLog: async (_key, value) => { trace.push(['task', JSON.parse(JSON.stringify(value))]); },
    createActivationManualHold: async value => { trace.push(['hold', value.reason]); },
    markCdkUnused: async () => { trace.push(['release-code']); },
    resetCdkFailure: async () => { trace.push(['reset-code']); },
    resetActivationAttemptFailure: async () => {},
    recordCdkFailure: async () => false
  };
  const routing = {
    nextAttempt: async accepted => {
      if (failReselect) throw new Error('synthetic route unavailable');
      assert.equal(accepted.region, 'PH'); selected++;
      return route(selected);
    },
    describe: () => 'safe selected route',
    verifiedStart(selectedRoute, callback) {
      return async env => {
        assert.equal(env.PROXY, selectedRoute.proxy);
        assert.equal(env.PAYMENT_REGION_OVERRIDE, 'PH');
        return callback(env);
      };
    }
  };
  const sandbox = {
    path: { join: (...parts) => parts.join('/') }, __dirname: '/synthetic',
    process: { env: {} }, console: { error: (...values) => failures.push(String(values[1])), warn() {} },
    store: nativeStore, MAX_PROCESS_ATTEMPTS: 3,
    extractEmailFromSession: () => 'fixture@example.test', getActivationAccountKey: () => 'synthetic-account',
    requireReadablePlanType: value => value, getRechargeRouting: async () => routing,
    normalizeTaskProgress: value => value, broadcastToTask() {}, logTask() {},
    buildHcaptchaEnvFromConfig: () => ({ env: {} }),
    spawnWorkerWithBrowser: async ({ runtimeEnv, runScript }) => runScript(runtimeEnv),
    runCheckoutScript: async (_key, _path, env, attempt) => {
      runs.push({ attempt, proxy: env.PROXY, region: env.PAYMENT_REGION_OVERRIDE });
      return { output: 'synthetic attempt ' + attempt,
        analysis: analyses[Math.min(attempt - 1, analyses.length - 1)] };
    },
    extractCardLast4FromOutput: () => '', getCheckoutProgress: () => 20,
    getManualReviewMessage: value => 'review: ' + value,
    extractTaskMediaFromOutput: () => ({ screenshots: [], videos: [] }),
    isCardPoolExhaustedIssue: () => false, isNoActivationEligibilityMessage: () => false,
    notifyTaskOutcome: value => { trace.push(['notification', value.event]); },
    releaseForegroundSlot: () => { trace.push(['release-slot']); released(); }, getTotalActiveJobs: () => 1
  };
  const worker = section(source, 'function spawnActivationWorker(', 'async function handleActivationRequest(');
  runInNewContext(worker + '\nspawnActivationWorker(input);', { ...sandbox,
    input: { task: { jobKey: 'synthetic-job' }, token: 'synthetic', sessionRaw: '{}', cdk: 'synthetic-code',
      cdkDetails: { plan_type: 'plus' }, executionRoute: integrated ? route(1) : undefined } });
  await finished;
  if (failReselect) {
    assert.equal(failures.length, 1); assert.match(failures[0], /synthetic route unavailable/);
  } else assert.deepEqual(failures, []);
  return { runs, trace };
}

test('native outer attempts, stop decisions and resource cleanup match upstream while every attempt reselects a proxy', async () => {
  const original = await readFile(fileURLToPath(new URL('../.upstream/codexdaichong/server.js', import.meta.url)), 'utf8');
  for (const analyses of [
    [{ status: 'retry', shouldRetry: true }, { status: 'success', shouldRetry: false }],
    [{ status: 'retry', shouldRetry: true }],
    [{ status: 'manual', shouldRetry: false }]
  ]) {
    const baseline = await activationTrace(original, analyses, false);
    const candidate = await activationTrace(server, analyses, true);
    assert.deepEqual(candidate.trace, baseline.trace);
    assert.deepEqual(candidate.runs.map(({ region, ...run }) => run), baseline.runs.map(({ region, ...run }) => run));
    assert.ok(candidate.runs.every(run => run.region === 'PH'));
    assert.equal(new Set(candidate.runs.map(run => run.proxy)).size, candidate.runs.length);
  }
  const retry = [{ status: 'retry', shouldRetry: true }];
  const baseline = await activationTrace(original, retry, false, true);
  const candidate = await activationTrace(server, retry, true, true);
  assert.deepEqual(candidate.trace, baseline.trace);
  assert.equal(candidate.runs.length, 1, 'a failed reselection must not launch another child');
});
test('adapted management bundle parses and has one authoritative read-only debug region', () => {
  const js = String(assets.get('/admin.js').body), html = String(assets.get('/admin').body);
  new Script(js);
  for (const plan of ['plus', 'pro100', 'pro200', 'pro500']) assert.ok(html.includes('id="route_plan_' + plan + '"'));
  assert.ok(js.includes('select.disabled = true'));
  assert.ok(js.includes('/integrations/codexdaichong/api/admin/recharge-routing'));
  assert.ok(!js.includes('function buildScreenshotUrl(path) {\n    return \'/api/'));
});
test('debug screenshot rendering completes polling and restores the launch button with unified auth', async () => {
  const source = String(assets.get('/admin.js').body);
  const elements = Object.fromEntries(['checkout_result_box', 'checkout_result_status', 'checkout_result_email',
    'checkout_result_url_wrap', 'checkout_screenshot_wrap', 'checkout_job_hint', 'checkout_generate_btn']
    .map(id => [id, { style: {}, disabled: true }]));
  let cleared = false;
  const renderer = section(source, '        function renderCheckoutDebugStatus(', '        async function startCheckoutDebug()');
  const helper = source.slice(source.lastIndexOf('function buildScreenshotUrl(path)'));
  const sandbox = { document: { getElementById: id => elements[id] },
    checkoutDebugJobKey: 'synthetic', checkoutDebugStatusPollTimer: 123,
    authFetch: async () => ({ json: async () => ({ success: true, status: 'failed', message: 'fixture',
      screenshots: ['checkout_debug/synthetic image.png'] }) }),
    escapeHtml: value => String(value).replaceAll('"', '&quot;'),
    clearInterval: id => { assert.equal(id, 123); cleared = true; }, lucide: { createIcons() {} }, showMessage() {} };
  await runInNewContext(renderer + helper + '\npollCheckoutDebugStatus(false);', sandbox);
  assert.equal(elements.checkout_generate_btn.disabled, false); assert.equal(cleared, true);
  const rendered = elements.checkout_screenshot_wrap.innerHTML;
  assert.ok(rendered.includes('/integrations/codexdaichong/api/admin/screenshots?path=checkout_debug%2Fsynthetic%20image.png'));
  assert.ok(!rendered.includes('token='));
});
