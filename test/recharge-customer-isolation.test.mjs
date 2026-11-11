import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { signRechargeAssertion, verifyRechargeAssertion } from '../modules/recharge/assertion.mjs';
import { createCodexdaichongGateway } from '../modules/recharge/codexdaichong/gateway.mjs';
import { createNativeRechargeAdapter } from '../modules/recharge/codexdaichong/native-adapter.mjs';

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
    const step = (offset, source, text, key = jobKey) => ({ ts: at + offset, jobKey: key, source, text });
    return Response.json({
      success: true, task: { jobKey, rawOutput: 'private-raw-output' }, runtimeEntries: [
        step(0, 'task', '尝试 1 启动自动化 proxy=yes'),
        step(1000, 'spawn/a1/stdout', '正在检查代理连通性...'),
        step(2000, 'spawn/a1/stdout', '✅ [系统] 代理连接成功! 代理公网 IP: private-exit'),
        step(3000, 'spawn/a1/stdout', '✅ [步骤] Checkout 页面已打开: https://example.test/private-url'),
        step(3100, 'spawn/a1/stdout', '✅ [步骤] Checkout 页面已打开，开始信用卡支付流程...'),
        step(3500, 'spawn/a1/stdout', '[Stripe] Step 6: private-form'),
        step(4000, 'spawn/a1/stdout', '[Stripe] ✅ 已点击提交按钮 (private-text)'),
        step(4500, 'spawn/a1/stdout', '[Stripe] Step 10: 等待支付结果（合成）...'),
        step(5000, 'spawn/a1/stdout', '支付失败，未支付成功'),
        step(5500, 'spawn/a1/stdout', '[Stripe] Step 6: private-other-task', 'unrelated-task'),
        step(5600, 'captcha', '[Stripe] Step 6: private-source'),
        step(6000, 'task', '任务结束 status=failed progress=90 message=private-terminal')
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
  assert.equal((await read({ isAdmin: false })).data.steps, undefined);
  assert.equal((await read({ details: false })).data.steps, undefined);
  assert.equal((await read({ site: 'cross-site' })).data.steps, undefined);
  returnedJob = 'wrong-job';
  assert.equal((await read()).success, false);
  assert.equal(detailReads, 0);
  returnedJob = jobKey;
  const { data } = await read();
  assert.equal(data.manualReview, true);
  assert.deepEqual(data.steps, [
    { stage: 'started', at },
    { stage: 'network_check', at: at + 1000 },
    { stage: 'network_ready', at: at + 2000 },
    { stage: 'checkout_open', at: at + 3000 },
    { stage: 'payment_details', at: at + 3500 },
    { stage: 'payment_submitted', at: at + 4000 },
    { stage: 'payment_check', at: at + 4500 }
  ]);
  assert.equal(data.terminalAt, at + 6000);
  detailUnavailable = true;
  const fallback = await read();
  assert.equal(fallback.data.manualReview, true);
  assert.equal(fallback.data.steps, undefined);
  assert.equal(detailReads, 2);
});
