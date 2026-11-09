import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { loadCodexdaichongAssets } from '../modules/recharge/codexdaichong/assets.mjs';
import { createCodexdaichongGateway } from '../modules/recharge/codexdaichong/gateway.mjs';

const prefix = '/integrations/codexdaichong';
const member = { id: 'u-1', email: 'member@example.test', admin: false, sensitive: false };
const admin = { ...member, id: 'u-2', admin: true, sensitive: true };

test('browser progress uses only confirmed native receipts and never resends a submission', async (t) => {
  const secret = randomBytes(48).toString('base64url');
  const origin = 'https://recharge.example.test';
  const jobKey = 'fixture-job-1';
  const path = '/api/task-status/' + jobKey;
  let submissions = 0;
  let receipt = { status: 503, body: { success: false, message: '系统维护中，请稍后再试' } };
  let task = { jobKey, status: 'running', isTerminal: false, progress: 100, message: '正在开通中' };
  const engine = await listen(t, async (req, res) => {
    let status = 200;
    let body;
    if (req.url === '/api/run-process') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { cdk: 'KC-SYNTHETIC', session: 'synthetic-session' });
      submissions++;
      ({ status, body } = receipt);
    } else if (decodeURIComponent(req.url).trimEnd() === path) {
      body = { success: true, data: task };
    } else if (req.url === '/api/cdk/query?cdk=KC-SYNTHETIC') {
      body = { success: true, data: { status: '开通中', jobKey } };
    } else {
      assert.equal(req.url, '/api/cdk/query?cdk=KC-USED');
      body = { success: true, data: { status: '已使用', jobKey: null } };
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const gateway = createCodexdaichongGateway({
    upstreamUrl: engine, publicOrigin: origin, secret, getUnifiedPrincipal: () => member
  });
  const host = await listen(t, gateway.handle);
  const lookup = async (path) => (await fetch(host + prefix + path)).json();
  const submit = () => fetch(host + prefix + '/api/run-process', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cdk: 'KC-SYNTHETIC', session: 'synthetic-session' })
  });

  const maintenance = await submit();
  assert.equal(maintenance.status, 503);
  assert.deepEqual(await maintenance.json(), {
    success: false, notAccepted: true, code: 'maintenance_mode',
    message: '系统维护中，充值任务未启动，请待维护结束后再提交'
  });
  receipt = { status: 503, body: { success: false, message: '其他异常：系统维护中，请稍后再试' } };
  assert.equal((await (await submit()).json()).notAccepted, undefined);
  receipt.body = { success: false, message: '系统维护中，请稍后再试', notAccepted: true, code: 'maintenance_mode', jobKey };
  assert.equal((await (await submit()).json()).notAccepted, undefined);
  receipt = {
    status: 200,
    body: { success: true, jobKey, message: '正在恢复原任务', stage: 'paid', session: 'private-fixture' }
  };
  assert.deepEqual(await (await submit()).json(), { success: true, jobKey });
  receipt.body.message = '任务已启动，正在为您开通中...';
  assert.deepEqual(await (await submit()).json(), { success: true, jobKey, stage: 'preparing' });
  assert.equal(submissions, 5);

  const generic = (await lookup(path)).data;
  assert.equal(generic.stage, undefined);
  assert.equal(generic.progress, 99);
  task = {
    ...task, message: '正在填写银行卡信息...', cdkCode: 'private-code', session: 'private-session',
    cardLast4: '1234', phone: 'private-phone', screenshots: ['private-path'],
    captcha: { status: 'pending', id: 'private-id', url: 'https://example.test/private', expiresAt: '1794270000' }
  };
  const presentedTask = (await lookup(path)).data;
  const captchaId = presentedTask.captcha.id;
  assert.match(captchaId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(presentedTask, {
    jobKey, status: 'running', isTerminal: false, progress: 99, stage: 'payment_details',
    captcha: { stage: 'awaiting_captcha', id: captchaId, expiresAt: new Date(1794270000000).toISOString() }
  });
  assert.deepEqual(
    await lookup('/api/task-status/%66ixture%2Djob-1%20'),
    await lookup(path),
    'encoded equivalents must receive the same safe projection'
  );
  task.captcha.id = 'new-private-id';
  assert.notEqual((await lookup(path)).data.captcha.id, captchaId);
  task.message = '日志提示：支付失败，未支付成功';
  assert.equal((await lookup(path)).data.stage, undefined);
  task.message = '付款成功';
  assert.equal((await lookup(path)).data.stage, 'paid');
  assert.equal((await lookup(path)).data.status, 'running');
  task = { ...task, status: 'failed', isTerminal: true, message: '已转人工核实；内部诊断' };
  const held = await lookup(path);
  assert.equal(held.data.manualReview, true);
  assert.equal(held.data.message, undefined);
  task = { ...task, status: 'success', isTerminal: false };
  assert.equal((await lookup(path)).success, false);
  task.isTerminal = true;
  assert.equal((await lookup(path)).data.progress, 100);
  task.jobKey = 'different-task';
  assert.equal((await lookup(path)).success, false);

  assert.deepEqual((await lookup('/api/cdk/query?cdk=KC-SYNTHETIC')).data, { status: '开通中', jobKey });
  assert.deepEqual((await lookup('/api/cdk/query?cdk=KC-USED')).data, { status: '已使用', jobKey: null });
  assert.equal(submissions, 5);
});

test('proxy import normalizes a complete batch before forwarding and rejects invalid or unauthorized writes', async t => {
  const received = [];
  const secret = randomBytes(48).toString('base64url');
  const engine = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(Number(req.headers['content-length']), body.length);
    received.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, added: 1 }));
  });
  const origin = 'http://proxy-import.test';
  const gateway = createCodexdaichongGateway({ upstreamUrl: engine, publicOrigin: origin, secret,
    getUnifiedPrincipal: req => req.headers['x-test-role'] === 'admin' ? admin
      : req.headers['x-test-role'] === 'employee' ? member : null });
  const host = await listen(t, (req, res) => { void gateway.handle(req, res); });
  const url = host + prefix + '/api/admin/proxies';
  const raw = 'Socks5://gate.example.test:8082:example-session-{session}:p@ss:word';
  const canonical = 'socks5://example-session-{session}:p%40ss%3Aword@gate.example.test:8082';
  const send = (body, role = 'admin', from = origin, type = 'application/json') => fetch(url, {
    method: 'POST', headers: { Origin: from, 'content-type': type, 'x-test-role': role },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  assert.equal((await send({ proxies: [raw, canonical] })).status, 200);
  assert.deepEqual(received, [{ proxies: [canonical] }]);
  assert.equal((await send({ proxy_url: raw })).status, 200, '保留原单条别名兼容');
  const before = received.length;
  const rejected = await send({ proxies: [raw, 'https://api.example.test/extract?id=synthetic'] });
  assert.equal(rejected.status, 400);
  const message = (await rejected.json()).message;
  assert.match(message, /第 2 行.*整批未保存/);
  assert(!message.includes('p@ss') && !message.includes('synthetic'));
  assert.equal((await send({ proxies: [raw] }, 'employee')).status, 403);
  assert.equal((await send({ proxies: [raw] }, 'guest')).status, 401);
  assert.equal((await send({ proxies: [raw] }, 'admin', 'http://other.test')).status, 403);
  assert.equal((await send('{invalid')).status, 400);
  assert.equal((await send({ proxies: [raw] }, 'admin', origin, 'text/plain')).status, 415);
  assert.equal((await send(JSON.stringify({ proxies: ['x'.repeat(15 * 1024 * 1024)] }))).status, 413);
  assert.equal(received.length, before, '失败批次没有向执行器发送任何条目');
});

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('gateway accepts the unified session only and preserves upstream JSON and CAPTCHA semantics', async (t) => {
  const secret = randomBytes(48).toString('base64url');
  const upstreamRequests = [];
  const engine = await listen(t, async (req, res) => {
    const [payload, signature] = req.headers['x-id-recharge-assertion'].split('.');
    assert.equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'));
    const claim = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claim.path, req.url);
    assert.equal(claim.method, req.method);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      claim,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      body: Buffer.concat(chunks).toString()
    });
    if (req.url === '/api/task-captcha/fixture') {
      res
        .writeHead(302, {
          Location: 'https://validation.example.test/challenge',
          'Set-Cookie': 'upstream=fixture'
        })
        .end();
    } else {
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=fixture' })
        .end(
          JSON.stringify(
            req.url === '/api/public/runtime'
              ? { success: true, runtime: { active_foreground_jobs: 0, max_foreground_jobs: 1 } }
              : { success: true }
          )
        );
    }
  });
  let gateway;
  const origin = await listen(t, (req, res) => gateway.handle(req, res));
  gateway = createCodexdaichongGateway({
    upstreamUrl: engine,
    publicOrigin: origin,
    secret,
    getUnifiedPrincipal: (req) => ({ 'id=member': member, 'id=admin': admin })[req.headers.cookie]
  });
  const makeRequest = (path, init) => fetch(origin + prefix + path, init);
  const memberHeaders = { Cookie: 'id=member', Authorization: 'Bearer forged' };
  const adminHeaders = { Cookie: 'id=admin', Origin: origin };

  assert.equal((await makeRequest('/status')).status, 401);
  assert.deepEqual(await (await makeRequest('/status', { headers: memberHeaders })).json(), {
    ready: true,
    admin: false
  });
  assert.equal(
    (await makeRequest('/admin?view=dashboard', { headers: memberHeaders })).status,
    403
  );
  assert.equal((await makeRequest('/api/admin/cards', { headers: memberHeaders })).status, 403);
  assert.equal(
    (await makeRequest('/api/admin/change-password/', { headers: adminHeaders, method: 'POST' }))
      .status,
    404
  );
  assert.equal(
    (await makeRequest('/api/admin/login', { headers: adminHeaders, method: 'POST' })).status,
    404
  );
  assert.equal(
    (await makeRequest('/api/external/cards/push', { headers: adminHeaders, method: 'POST' }))
      .status,
    404
  );
  assert.equal(
    (await makeRequest('/api/cdk/query-batch', { headers: memberHeaders, method: 'POST' })).status,
    403
  );
  const success = await makeRequest('/api/cdk/query-batch', {
    method: 'POST',
    headers: {
      ...memberHeaders,
      Origin: origin,
      'Content-Type': 'application/json',
      'X-ID-Recharge-Assertion': 'forged'
    },
    body: '{"cdks":["fixture"]}'
  });
  assert.deepEqual(await success.json(), { success: true });
  assert.equal(success.headers.get('set-cookie'), null);
  assert.deepEqual(upstreamRequests.at(-1).claim.actor, { ...member, clientIp: '127.0.0.1' });
  assert.equal(upstreamRequests.at(-1).cookie, undefined);
  assert.equal(upstreamRequests.at(-1).authorization, undefined);
  assert.equal(upstreamRequests.at(-1).body, '{"cdks":["fixture"]}');
  assert.equal((await makeRequest('/api/admin/cards', { headers: adminHeaders })).status, 200);
  assert.deepEqual(upstreamRequests.at(-1).claim.actor, { ...admin, clientIp: '127.0.0.1' });
  await makeRequest('/api/public/runtime', { headers: { ...memberHeaders, 'x-forwarded-for': 'spoofed, 203.0.113.17', 'x-real-ip': 'spoofed' } });
  assert.equal(upstreamRequests.at(-1).claim.actor.clientIp, '203.0.113.17');

  const captcha = await makeRequest('/api/task-captcha/fixture', {
    headers: memberHeaders,
    redirect: 'manual'
  });
  assert.equal(captcha.status, 302);
  assert.equal(captcha.headers.get('location'), 'https://validation.example.test/challenge');
  assert.equal(captcha.headers.get('set-cookie'), null);
});

test('upstream pages retain the signed-in operations without their own login or external runtime assets', async () => {
  const assets = await loadCodexdaichongAssets();
  assert.equal(assets.has('/admin-login.html'), false);
  for (const path of ['/redeem', '/subscription', '/admin']) {
    const page = assets.get(path);
    assert.match(page.csp, /frame-ancestors 'self'/);
    assert.doesNotMatch(page.body, /(?:src|href)="https:\/\/(?:unpkg|fonts\.)/);
    for (const [, script] of page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new Script(script));
    }
  }
  assert.match(assets.get('/redeem').body, /\/integrations\/codexdaichong\/api\/run-process/);
  assert.match(assets.get('/redeem').body, /\/integrations\/codexdaichong\/api\/task-status\//);
  assert.doesNotMatch(assets.get('/redeem').body, /\/integrations\/codexdaichong\/socket/);
  assert.doesNotMatch(assets.get('/admin').body, /修改后台密码|绑定 Google Authenticator/);
  assert.match(assets.get('/admin').body, /Session 管理|CDK 管理/);
  const script = assets.get('/admin.js').body;
  assert.doesNotMatch(script, /plus_admin_token|localStorage\./);
  assert.doesNotThrow(() => new Script(script));
});
