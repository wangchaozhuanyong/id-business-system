import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  createLoopbackVendureRechargeBridge,
  rechargeWorkerPrefix,
  signRechargeWorkerRequest,
  vendureRechargePrefix
} from '../modules/recharge/vendure/loopback-bridge.mjs';
import {
  createVendureCodexdaichongWorker,
  originalRechargeStage
} from '../modules/recharge/vendure/codexdaichong-worker.mjs';

const session = JSON.stringify({
  user: { id: 'synthetic-user', email: 'synthetic@example.test' },
  accessToken: 'synthetic-authorization-for-offline-test'
});

function fixture(t, codes = [{ code: 'synthetic-code', plan: 'plus' }]) {
  const vendureKey = randomBytes(32).toString('hex');
  const workerSecret = randomBytes(32).toString('hex');
  let at = Date.now();
  const bridge = createLoopbackVendureRechargeBridge({
    codes, vendureKey, workerSecret, now: () => at
  });
  t.after(() => bridge.close());
  async function post(path, body = {}, headers = {}) {
    const bytes = Buffer.from(JSON.stringify(body));
    const response = {};
    await bridge.handle({
      url: path, method: 'POST', socket: { remoteAddress: '127.0.0.1' },
      headers: { 'content-type': 'application/json', ...headers },
      async *iterator() { yield bytes; }, resume() {}
    }, {
      headersSent: false, destroyed: false,
      writeHead(status) { this.headersSent = true; response.status = status; },
      end(value) { response.body = JSON.parse(value); }
    });
    return response;
  }
  const vendure = (action, body = {}) => post(vendureRechargePrefix + '/' + action, body, {
    'x-vendure-recharge-key': vendureKey, 'x-vendure-client-ip': '203.0.113.10'
  });
  const worker = (action, body = {}) => {
    const path = rechargeWorkerPrefix + '/' + action;
    return post(path, body, signRechargeWorkerRequest(workerSecret, path, JSON.stringify(body), at));
  };
  return { vendure, worker, post, workerSecret, advance(ms) { at += ms; } };
}

test('progress is a fixed safe projection and renews observation without changing the original task', async (t) => {
  const f = fixture(t);
  const submitted = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  assert.equal(submitted.message, '等待执行');
  const identity = { id: submitted.id, taskToken: submitted.taskToken };
  const lease = (await f.worker('claim')).body.task;
  assert.equal(lease.message, '处理中');
  const update = { id: lease.id, leaseToken: lease.leaseToken, stage: 'started', upstreamJobId: 'original-job' };
  assert.equal((await f.worker('progress', { ...update, cardNumber: 'synthetic-card-data' })).status, 400);
  assert.equal((await f.worker('progress', { ...update, stage: 'raw-diagnostic' })).status, 400);
  assert.equal((await f.worker('progress', { ...update, upstreamJobId: 123 })).status, 400);
  assert.equal((await f.worker('progress', { ...update, leaseToken: 'wrong' })).status, 404);
  assert.equal((await f.worker('progress', update)).body.message, '已开始执行');
  f.advance(240_000);
  const heartbeat = await f.worker('progress', { ...update, stage: 'processing' });
  assert(heartbeat.body.leaseUntil > lease.leaseUntil);
  f.advance(120_000);
  const view = (await f.vendure('task', identity)).body;
  assert.equal(view.status, 'running');
  assert.equal(view.message, '处理中');
  assert.deepEqual(Object.keys(view).sort(), ['id', 'message', 'plan', 'stage', 'status', 'updatedAt']);
  assert.equal((await f.worker('progress', { ...update, upstreamJobId: 'another-job' })).status, 400);
  assert.deepEqual((await f.worker('claim')).body, { task: null });
  const result = await f.worker('result', {
    id: lease.id, leaseToken: lease.leaseToken, outcome: 'unknown', upstreamJobId: 'original-job'
  });
  assert.equal(result.body.message, '结果待核实，请勿重复充值，请联系客服处理。');
  assert.equal((await f.worker('progress', update)).status, 409);
  assert.equal((await f.vendure('submit', { code: 'synthetic-code', session })).body.id, submitted.id);
});

test('the bridge accepts every canonical plan from the pinned engine instead of restricting the merchant to old plans', async (t) => {
  const canonicalPlans = ['plus', 'pro100', 'pro200', 'pro500'];
  const f = fixture(t, canonicalPlans.map((plan) => ({ code: 'synthetic-' + plan, plan })));
  for (const plan of canonicalPlans) {
    const accepted = await f.vendure('submit', { code: 'synthetic-' + plan, session });
    assert.equal(accepted.body.plan, plan);
    assert.equal(accepted.body.status, 'queued');
    const claimed = await f.worker('claim');
    assert.equal(claimed.body.task.plan, plan);
    assert.equal(claimed.body.task.executionCode, 'synthetic-' + plan);
  }
});

test('only explicit known original messages can produce a detailed payment stage', () => {
  assert.equal(originalRechargeStage('正在开通中'), 'processing');
  assert.equal(originalRechargeStage('正在进行第 1 次尝试...'), 'processing');
  assert.equal(originalRechargeStage('支付失败，未支付成功'), 'processing');
  assert.equal(originalRechargeStage('card_number=synthetic&cvc=synthetic'), 'processing');
  assert.equal(originalRechargeStage('https://example.test/private-checkout'), 'processing');
  assert.equal(originalRechargeStage('正在填写银行卡信息...'), 'payment_details');
  assert.equal(originalRechargeStage('正在付款'), 'paying');
  assert.equal(originalRechargeStage('付款成功'), 'paid');
  assert.equal(originalRechargeStage('正在核对订阅状态'), 'subscription_check');
});

test('confirmed failure stays bound to the observed original job and exposes only the fixed customer prompt', async (t) => {
  const f = fixture(t);
  await f.vendure('submit', { code: 'synthetic-code', session });
  const lease = (await f.worker('claim')).body.task;
  const identity = { id: lease.id, leaseToken: lease.leaseToken };
  await f.worker('progress', { ...identity, upstreamJobId: 'observed-job', stage: 'started' });
  const receipt = {
    ...identity, outcome: 'confirmed_failure', evidenceId: 'codexdaichong:observed-job', upstreamJobId: 'observed-job'
  };
  assert.equal((await f.worker('result', { ...receipt, upstreamJobId: 'different-job' })).status, 400);
  assert.equal((await f.worker('result', { ...receipt, message: 'synthetic-private-diagnostic' })).status, 400);
  const failed = await f.worker('result', receipt);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.stage, 'failed');
  assert.equal(failed.body.message, '执行失败，请联系客服处理。');
  assert.deepEqual(Object.keys(failed.body).sort(), ['id', 'message', 'plan', 'stage', 'status', 'updatedAt']);
});

test('only an explicit route rejection before execution is definitive; other missing jobs remain unknown', async t => {
  for (const explicit of [true, false]) {
    const f = fixture(t);
    const submitted = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
    let starts = 0;
    const mock = t.mock.method(globalThis, 'fetch', async (input, options) => {
      const url = new URL(input);
      if (url.port === '31992') {
        const reply = await f.post(url.pathname, JSON.parse(options.body), options.headers);
        return new Response(JSON.stringify(reply.body), { status: reply.status });
      }
      if (url.pathname === '/api/public/runtime') return Response.json({ success: true });
      assert.equal(url.pathname, '/api/run-process'); starts++;
      return Response.json({ success: false, code: 'recharge_route_unavailable',
        ...(explicit ? { execution_started: false } : {}) }, { status: 409 });
    });
    const run = createVendureCodexdaichongWorker({
      bridgeUrl: 'http://127.0.0.1:31992', upstreamUrl: 'http://127.0.0.1:31993',
      workerSecret: f.workerSecret, upstreamSecret: randomBytes(32).toString('hex'), pollIntervalMs: 1
    });
    assert.deepEqual(await run(), { status: explicit ? 'failed' : 'awaiting_review' });
    const view = (await f.vendure('task', { id: submitted.id, taskToken: submitted.taskToken })).body;
    assert.equal(view.status, explicit ? 'failed' : 'awaiting_review');
    assert.equal(starts, 1); mock.mock.restore();
  }
});

test('worker accepts the original runtime and never adds plan, card or retry overrides', async (t) => {
  const f = fixture(t);
  const submitted = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  const activationBodies = [];
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.port === '31992') {
      const reply = await f.post(url.pathname, JSON.parse(options.body), options.headers);
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }
    assert.equal(url.port, '31993');
    if (url.pathname === '/api/public/runtime') return Response.json({ success: true });
    if (url.pathname === '/api/run-process') {
      activationBodies.push(JSON.parse(options.body));
      return Response.json({ success: true, jobKey: 'original-job' });
    }
    assert.equal(url.pathname, '/api/task-status/original-job');
    polls++;
    return Response.json({ success: true, data: {
      jobKey: 'original-job', cdkCode: 'synthetic-code',
      status: polls === 1 ? 'running' : 'success', isTerminal: polls !== 1,
      message: '正在开通中', card_number: 'synthetic-private-data', screenshot: '/private-media'
    } });
  });
  const run = createVendureCodexdaichongWorker({
    bridgeUrl: 'http://127.0.0.1:31992', upstreamUrl: 'http://127.0.0.1:31993',
    workerSecret: f.workerSecret, upstreamSecret: randomBytes(32).toString('hex'),
    pollIntervalMs: 1
  });
  assert.deepEqual(await run(), { status: 'succeeded' });
  assert.deepEqual(activationBodies, [{ cdk: 'synthetic-code', session }]);
  const view = (await f.vendure('task', { id: submitted.id, taskToken: submitted.taskToken })).body;
  assert.equal(view.message, '开通成功');
  assert.equal(JSON.stringify(view).includes('synthetic-private-data'), false);
  assert.equal(JSON.stringify(view).includes('private-media'), false);
  assert.deepEqual(await run(), { status: 'idle' });
  assert.equal(activationBodies.length, 1);
});

test('collector failure and ambiguous activation never cancel or resend the original payment', async (t) => {
  const f = fixture(t);
  const submitted = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  let activationCount = 0;
  let statusCount = 0;
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    paths.push(url.pathname);
    if (url.port === '31992') {
      if (url.pathname.endsWith('/progress')) throw new Error('synthetic collector outage');
      const reply = await f.post(url.pathname, JSON.parse(options.body), options.headers);
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }
    if (url.pathname === '/api/public/runtime') return Response.json({ success: true });
    if (url.pathname === '/api/run-process') {
      activationCount++;
      return Response.json({ success: true, jobKey: 'original-job' });
    }
    statusCount++;
    return Response.json({ success: true, data: {
      jobKey: 'original-job', cdkCode: 'synthetic-code', status: 'manual', isTerminal: true,
      message: 'synthetic-private-diagnostic'
    } });
  });
  const run = createVendureCodexdaichongWorker({
    bridgeUrl: 'http://127.0.0.1:31992', upstreamUrl: 'http://127.0.0.1:31993',
    workerSecret: f.workerSecret, upstreamSecret: randomBytes(32).toString('hex')
  });
  assert.deepEqual(await run(), { status: 'awaiting_review' });
  assert.equal(statusCount, 1);
  const view = (await f.vendure('task', { id: submitted.id, taskToken: submitted.taskToken })).body;
  assert.equal(view.message, '结果待核实，请勿重复充值，请联系客服处理。');
  assert.equal(JSON.stringify(view).includes('synthetic-private-diagnostic'), false);
  assert.deepEqual(await run(), { status: 'idle' });
  assert.equal(activationCount, 1);
  assert.equal(paths.some((path) => /cancel|retry|cards|admin/.test(path)), false);
});

test('Session shape is delegated unchanged and customer IP reaches the signed original request', async t => {
  const f = fixture(t);
  const raw = 'synthetic-bare-credential-delegated-to-native';
  await f.vendure('submit', { code: 'synthetic-code', session: raw });
  let seen = false;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.port === '31992') {
      const reply = await f.post(url.pathname, JSON.parse(options.body), options.headers);
      return Response.json(reply.body, { status: reply.status });
    }
    if (url.pathname === '/api/public/runtime') return Response.json({ success: true });
    if (url.pathname === '/api/run-process') {
      const claims = JSON.parse(Buffer.from(options.headers['x-id-recharge-assertion'].split('.')[0], 'base64url'));
      assert.equal(claims.actor.clientIp, '203.0.113.10');
      assert.deepEqual(JSON.parse(options.body), { cdk: 'synthetic-code', session: raw });
      seen = true;
      return Response.json({ success: true, jobKey: 'original-manual-job' });
    }
    return Response.json({ success: true, data: { jobKey: 'original-manual-job', cdkCode: 'synthetic-code',
      status: 'failed', isTerminal: true, message: '订单处理超时，已转人工确认，请联系客服处理后再试' } });
  });
  const run = createVendureCodexdaichongWorker({ bridgeUrl: 'http://127.0.0.1:31992',
    upstreamUrl: 'http://127.0.0.1:31993', workerSecret: f.workerSecret,
    upstreamSecret: randomBytes(32).toString('hex'), pollIntervalMs: 1 });
  assert.deepEqual(await run(), { status: 'awaiting_review' });
  assert(seen);
  assert.deepEqual(await run(), { status: 'idle' });
});

test('late verified results reconcile the same original job without submitting a second activation', async t => {
  const f = fixture(t);
  const submitted = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  const lease = (await f.worker('claim')).body.task;
  const identity = { id: lease.id, leaseToken: lease.leaseToken, upstreamJobId: 'late-original-job' };
  await f.worker('progress', { ...identity, stage: 'started' });
  f.advance(301_000);
  assert.equal((await f.vendure('task', { id: submitted.id, taskToken: submitted.taskToken })).body.status, 'awaiting_review');
  assert.equal((await f.vendure('submit', { code: 'synthetic-code', session })).body.id, submitted.id);
  assert.deepEqual((await f.worker('claim')).body, { task: null });
  const result = { ...identity, outcome: 'confirmed_success', evidenceId: 'codexdaichong:late-original-job' };
  assert.equal((await f.worker('result', { ...result, upstreamJobId: 'different' })).status, 400);
  assert.equal((await f.worker('result', result)).body.status, 'succeeded');
  assert.equal((await f.worker('result', result)).body.status, 'succeeded');
});

test('definitive failure allows only an explicit new submission; unknown outcomes stay bound', async t => {
  const f = fixture(t);
  const first = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  const lease = (await f.worker('claim')).body.task;
  await f.worker('result', { id: lease.id, leaseToken: lease.leaseToken, outcome: 'confirmed_failure',
    upstreamJobId: 'failed-original-job', evidenceId: 'codexdaichong:failed-original-job' });
  assert.deepEqual((await f.worker('claim')).body, { task: null });
  const second = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  assert.notEqual(second.id, first.id);
  const retryLease = (await f.worker('claim')).body.task;
  await f.worker('result', { id: retryLease.id, leaseToken: retryLease.leaseToken, outcome: 'unknown', upstreamJobId: 'unknown-original-job' });
  assert.equal((await f.vendure('submit', { code: 'synthetic-code', session })).body.id, second.id);
  assert.equal((await f.vendure('task', { id: first.id, taskToken: first.taskToken })).body.status, 'failed');
});
