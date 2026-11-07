import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext, Script } from 'node:vm';
import { prepareCodexdaichong } from '../modules/recharge/codexdaichong/prepare.mjs';
import { loadCodexdaichongAssets } from '../modules/recharge/codexdaichong/assets.mjs';

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
  const phase = section(server, '        const gptApiConfig = await store.getGptApiConfig();\n        const useGptApi',
    '        const lockSuccess = await store.markCdkUsed(cdk);');
  let result;
  const res = { status(code) { result = { code }; return this; }, json(body) { result.body = body; return result; } };
  await runInNewContext('(async () => {' + phase + '\n})()', {
    res, planType: 'plus',
    store: { getGptApiConfig: async () => ({ enabled: false }), hasAvailableCard: async () => calls.push('card') },
    getRechargeRouting: async () => ({ resolve: async () => { throw Object.assign(new Error('private internal'),
      { publicMessage: '当前套餐的充值线路暂不可用，请联系客服处理。' }); } })
  });
  assert.equal(result.code, 409); assert.equal(result.body.execution_started, false);
  assert.match(result.body.message, /联系客服/);
  assert.ok(!JSON.stringify(result).includes('private internal')); assert.deepEqual(calls, []);
});
test('debug worker passes the selected route despite conflicting global settings, never selects a second proxy', async () => {
  const route = { proxy: 'socks5://synthetic-sticky', region: 'PH' };
  let actual, verifyCount = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const worker = section(server, 'function spawnCheckoutDebugWorker(', '/**\n * 第三方 GPT');
  const sandbox = {
    path: { join: (...parts) => parts.join('/') }, __dirname: '/synthetic',
    process: { env: { PROXY: 'wrong-global', PAYMENT_REGION_OVERRIDE: 'MY' } }, console: { error: finish },
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
      region: route.region, executionRoute: route } });
  await done;
  assert.equal(actual.PROXY, route.proxy); assert.equal(actual.PAYMENT_REGION_OVERRIDE, 'PH');
  assert.equal(actual.CHECKOUT_DEBUG_ONLY, '1'); assert.equal(actual.CHECKOUT_MODE, 'api');
  assert.equal(actual.CHECKOUT_API_ONLY, '0'); assert.equal(verifyCount, 1);
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
