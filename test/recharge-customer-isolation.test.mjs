import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { signRechargeAssertion, verifyRechargeAssertion } from '../modules/recharge/assertion.mjs';
import { createCodexdaichongGateway } from '../modules/recharge/codexdaichong/gateway.mjs';
import { createNativeRechargeAdapter } from '../modules/recharge/codexdaichong/native-adapter.mjs';
import { rechargeTaskStepHistory } from '../modules/recharge/codexdaichong/progress-presentation.mjs';

test('customer route restrictions reject private cards, credentials, diagnostics and media before native transport', async t => {
  let nativeRequests = 0;
  let tokenRequests = 0;
  const transport = t.mock.method(http, 'request', () => {
    nativeRequests++;
    throw new Error('synthetic-private-native-diagnostic');
  });
  syncBuiltinESMExports();
  t.after(() => { transport.mock.restore(); syncBuiltinESMExports(); });
  const secret = 'synthetic-bridge-secret-for-offline-test-only';
  const customer = { id: 'synthetic-customer', email: 'customer@example.test', admin: false, sensitive: false };
  const adapter = createNativeRechargeAdapter({ nativeUrl: 'http://127.0.0.1:31993', secret,
    async getNativeAdminToken() { tokenRequests++; throw new Error('synthetic-private-token'); }
  });
  async function request(path, actor = customer, extraHeaders = {}) {
    const result = {};
    await adapter.handle({
      url: path, method: 'GET', socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-id-recharge-assertion': signRechargeAssertion(secret, 'GET', path, actor), ...extraHeaders }
    }, {
      headersSent: false,
      writeHead(status) { this.headersSent = true; result.status = status; },
      end(raw) { result.body = JSON.parse(raw); }
    });
    assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
    return result;
  }
  for (const path of ['/api/admin/cards', '/API/ADMIN/CARDS/', '/api/admin/sessions', '/api/admin/cdks', '/api/admin/cdks/returns/stock',
    '/api/admin/task-logs/original-job', '/api/admin/proxies', '/api/admin/addresses',
    '/api/admin/checkout/generate', '/api/admin/orbitcard/usage',
    '/api/admin/screenshots?path=checkout_debug%2Ffixture.png', '/api/admin/video?path=fixture.webm'])
    assert.equal((await request(path)).status, 403);
  for (const path of ['/debug_screenshots/fixture.png', '/media/fixture.webm', '/admin.js',
    '/api/admin/cards%2F1', '/api/admin/cards?token=synthetic'])
    assert.equal((await request(path)).status, 404);
  const administrator = { ...customer, admin: true };
  for (const path of ['/api/admin/cards', '/api/admin/sessions', '/api/admin/cdks', '/api/admin/orbitcard/usage'])
    assert.equal((await request(path, administrator)).status, 403);
  assert.equal((await request('/api/admin/cdks/returns/stock', { ...administrator, sensitive: true })).status, 403);
  assert.equal((await request('/api/admin/cards', customer, { cookie: 'synthetic=private' })).status, 401);
  assert.equal((await request('/api/admin/cards', customer, { origin: 'https://example.test' })).status, 401);
  let upgradeReply;
  adapter.upgrade({ method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1' }, headers: {
    'x-id-recharge-assertion': signRechargeAssertion(secret, 'GET', '/', customer)
  } }, { end(value) { upgradeReply = value; } }, Buffer.alloc(0));
  assert.match(upgradeReply, /^HTTP\/1\.1 403/);
  assert.equal(nativeRequests, 0);
  assert.equal(tokenRequests, 0);
});

test('only an authorized workspace status read gets matching, dated and redacted steps', async t => {
  const secret = 'synthetic-bridge-secret-for-offline-test-only';
  const origin = 'https://workspace.example.test';
  const jobKey = 'workspace-task';
  const path = '/api/task-status/' + jobKey;
  const adminPath = '/api/admin/task-logs/' + jobKey;
  const at = Date.parse('2026-11-10T15:13:28Z');
  let returnedJob = jobKey, detailReads = 0, detailUnavailable = false;
  const transport = t.mock.method(http, 'request', (target, callback) => {
    assert.equal(target.method, 'GET');
    assert.ok([path, path + '?view=steps'].includes(target.path));
    const stream = new PassThrough();
    stream.setTimeout = () => {};
    stream.once('finish', () => {
      const body = { success: true, data: { jobKey: returnedJob, status: 'failed', progress: 90,
        isTerminal: true, message: '支付结果未确认，请人工处理', cdkCode: 'private-code' } };
      const reply = Readable.from([Buffer.from(JSON.stringify(body))]);
      reply.statusCode = 200;
      reply.headers = { 'content-type': 'application/json' };
      callback(reply);
    });
    return stream;
  });
  syncBuiltinESMExports();
  t.after(() => { transport.mock.restore(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    detailReads++;
    assert.equal(url.href, 'http://127.0.0.1:31993' + adminPath);
    assert.equal(verifyRechargeAssertion(secret, 'GET', adminPath, options.headers['x-id-recharge-assertion']).admin, true);
    if (detailUnavailable) throw new Error('private-transport');
    let id = 0;
    const step = (offset, source, text, key = jobKey) => ({ id: ++id, ts: at + offset, jobKey: key, source, text });
    return Response.json({
      success: true, task: { jobKey, rawOutput: 'private-raw-output' }, runtimeEntries: [
        step(0, 'task', '任务已创建，CDK=private-code mode=local'),
        step(100, 'task', '开始第 1/3 次尝试'),
        step(200, 'task', '尝试 1 启动自动化 proxy=yes'),
        step(500, 'spawn/a1/stdout', '正在检查代理连通性...'),
        step(800, 'spawn/a1/stdout', '✅ [系统] 代理连接成功! 代理公网 IP: private-exit'),
        step(1000, 'spawn/a1/stdout', 'CHECKOUT_SOURCE: api'),
        step(1100, 'spawn/a1/stdout', '✅ [步骤] Checkout 页面已打开: https://example.test/private-url'),
        step(1200, 'spawn/a1/stdout', '✅ [步骤] Checkout 页面已打开，开始信用卡支付流程...'),
        step(1500, 'spawn/a1/stdout', '[Stripe] Step 2: 填写信用卡字段（iframe 自动识别）...'),
        step(1600, 'spawn/a1/stdout', '[Stripe] ✅ 卡号已填写 (iframe[0])'),
        step(1800, 'spawn/a1/stdout', '[Stripe] Step 6: 填写账单地址与姓名...'),
        step(1900, 'spawn/a1/stdout', '[Stripe] ✅ OpenAI 账单地址已填写，姓名: private-name'),
        step(2000, 'spawn/a1/stdout', '[Stripe] Step 9: 点击订阅/支付...'),
        step(2001, 'spawn/a1/stdout', '[Stripe] Step 9: private-ambiguous-text'),
        step(2100, 'spawn/a1/stdout', '[Stripe] ✅ 已点击提交按钮 (private-button)'),
        step(2200, 'spawn/a1/stdout', '[Stripe] Step 10: 等待支付结果（最长 60s，含 Stripe 处理中）...'),
        step(2300, 'spawn/a1/stdout', '[Stripe] ❌ 检测到明确的银行卡拒付提示'),
        step(2400, 'task', '尝试 1 失败，准备重试'),
        step(2500, 'task', '开始第 2/3 次尝试'),
        step(2600, 'spawn/a2/stdout', '[Stripe] Step 2: 填写信用卡字段（iframe 自动识别）...'),
        step(2700, 'spawn/a2/stdout', '[Stripe] Step 6: 填写账单地址与姓名...', 'unrelated-task'),
        step(2800, 'captcha', '[Stripe] Step 6: 填写账单地址与姓名...'),
        step(2900, 'spawn/a2/stderr', '[Stripe] ✅ 已点击提交按钮 (private-error)'),
        step(3000, 'task', '任务结束 status=failed progress=90 message=private-terminal')
      ]
    });
  });
  const gateway = createCodexdaichongGateway({ upstreamUrl: 'http://127.0.0.1:31993', publicOrigin: origin, secret,
    getUnifiedPrincipal: req => ({ id: 'actor', email: 'actor@example.test', admin: req.isAdmin }) });
  async function read({ isAdmin = true, details = true, site = 'same-origin' } = {}) {
    const req = Object.assign(Readable.from([]), { method: 'GET', isAdmin,
      url: '/integrations/codexdaichong' + path + (details ? '?view=steps' : ''),
      headers: { 'sec-fetch-site': site }, socket: { remoteAddress: '127.0.0.1' } });
    const { promise, resolve } = Promise.withResolvers();
    const res = Object.assign(new EventEmitter(), { writeHead() {}, end: raw => resolve(JSON.parse(raw)) });
    await gateway.handle(req, res);
    const body = await promise;
    assert.doesNotMatch(JSON.stringify(body), /private-|unrelated-task/);
    return body;
  }
  for (const options of [{ isAdmin: false }, { details: false }, { site: 'cross-site' }]) {
    const { data } = await read(options);
    assert.equal(data.steps, undefined);
    assert.equal(data.stepsAvailable, undefined);
  }
  returnedJob = 'wrong-job';
  assert.equal((await read()).success, false);
  assert.equal(detailReads, 0);
  returnedJob = jobKey;
  const { data } = await read();
  assert.equal(data.manualReview, true);
  assert.equal(data.stepsAvailable, true);
  assert.deepEqual(data.steps, [
    { stage: 'created_browser', at, id: 1 },
    { stage: 'attempt_started', at: at + 100, id: 2, attempt: 1 },
    { stage: 'started', at: at + 200, id: 3, attempt: 1 },
    { stage: 'network_check', at: at + 500, id: 4, attempt: 1 },
    { stage: 'network_ready', at: at + 800, id: 5, attempt: 1 },
    { stage: 'checkout_api_ready', at: at + 1000, id: 6, attempt: 1 },
    { stage: 'checkout_open', at: at + 1200, id: 8, attempt: 1 },
    { stage: 'payment_details', at: at + 1500, id: 9, attempt: 1 },
    { stage: 'card_number_entered', at: at + 1600, id: 10, attempt: 1 },
    { stage: 'billing_details', at: at + 1800, id: 11, attempt: 1 },
    { stage: 'billing_entered', at: at + 1900, id: 12, attempt: 1 },
    { stage: 'payment_submit_attempt', at: at + 2000, id: 13, attempt: 1 },
    { stage: 'payment_submitted', at: at + 2100, id: 15, attempt: 1 },
    { stage: 'payment_check', at: at + 2200, id: 16, attempt: 1 },
    { stage: 'payment_decline_detected', at: at + 2300, id: 17, attempt: 1 },
    { stage: 'worker_retry', at: at + 2400, id: 18, attempt: 1 },
    { stage: 'attempt_started', at: at + 2500, id: 19, attempt: 2 },
    { stage: 'payment_details', at: at + 2600, id: 20, attempt: 2 }
  ]);
  assert.equal(data.terminalAt, at + 3000);
  detailUnavailable = true;
  const fallback = await read();
  assert.equal(fallback.data.manualReview, true);
  assert.equal(fallback.data.steps, undefined);
  assert.equal(fallback.data.stepsAvailable, false);
  assert.equal(detailReads, 2);
});

test('第三方执行路径只显示收到的查询与验证事件', () => {
  const jobKey = 'provider-job';
  const at = Date.parse('2026-11-10T15:13:28Z');
  const text = [
    '任务已创建，CDK=private-code mode=gpt-api',
    'Desolate Open Session 格式检查通过，套餐代码 private-plan',
    '状态轮询第 1 次失败: private-error',
    '订单查询第 2 次：status=processing，message=private-receipt',
    '订单需要人机验证 captcha=private-id url=ready',
    '订单查询第 3 次：status=succeeded，message=private-receipt'
  ];
  const history = rechargeTaskStepHistory({ success: true, task: { jobKey }, runtimeEntries: text.map((line, index) => ({
    id: index + 1, ts: at + index, jobKey, source: 'task', text: line
  })) }, { jobKey, status: 'running' });
  assert.deepEqual(history.steps, [
    { stage: 'created_provider', at, id: 1 },
    { stage: 'provider_input_checked', at: at + 1, id: 2 },
    { stage: 'provider_query_failed', query: 1, at: at + 2, id: 3 },
    { stage: 'provider_query', query: 2, at: at + 3, id: 4 },
    { stage: 'provider_verification', at: at + 4, id: 5 },
    { stage: 'provider_query', query: 3, at: at + 5, id: 6 }
  ]);
  assert.equal(history.terminalAt, undefined);
  assert.doesNotMatch(JSON.stringify(history), /private-/);
});
