import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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

function fixture(t, codes = [{ code: 'synthetic-code', plan: 'plus' }], store, options = {}) {
  const vendureKey = randomBytes(32).toString('hex');
  const workerSecret = randomBytes(32).toString('hex');
  let at = Date.now();
  const bridge = createLoopbackVendureRechargeBridge({
    codes, vendureKey, workerSecret, store, now: () => at, ...options
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
    'x-vendure-recharge-key': vendureKey, 'x-vendure-client-ip': '203.0.113.10',
    ...(options.lookupAdmission && { 'x-vendure-recharge-channel': 'moyao-ai' })
  });
  const worker = (action, body = {}) => {
    const path = rechargeWorkerPrefix + '/' + action;
    return post(path, body, signRechargeWorkerRequest(workerSecret, path, JSON.stringify(body), at));
  };
  return { vendure, worker, post, workerSecret, advance(ms) { at += ms; } };
}

function memoryStore() {
  const key = randomBytes(32);
  let current = { revision: 0, state: { tasks: [], nonces: [] } };
  let fault;
  let failures = 0;
  return {
    fingerprint: (purpose, value) => createHmac('sha256', key).update(purpose).update('\0').update(value).digest('hex'),
    load: () => structuredClone(current),
    failWhen(predicate, afterCommit = false) { fault = { predicate, afterCommit }; },
    get failures() { return failures; },
    commit(revision, state) {
      assert.equal(revision, current.revision);
      const fail = fault?.predicate(state);
      if (fail && !fault.afterCommit) {
        failures++;
        throw new Error('synthetic-private-storage-diagnostic');
      }
      current = { revision: revision + 1, state: structuredClone(state) };
      if (fail) {
        failures++;
        fault = undefined;
        throw new Error('synthetic-private-storage-diagnostic');
      }
      return current.revision;
    }
  };
}

test('a reviewed pre-execution failure needs fresh native admission and creates at most one new receipt', async (t) => {
  const code = 'KC-' + 'A'.repeat(15);
  const store = memoryStore();
  const previousId = '21111111-1111-4111-8111-111111111111';
  const previous = {
    id: previousId, codeRef: store.fingerprint('code', code), plan: 'plus',
    status: 'failed', updatedAt: Date.now(),
    result: {
      status: 'failed',
      evidenceRef: store.fingerprint('evidence', 'codexdaichong:route:' + previousId)
    }
  };
  store.commit(0, { tasks: [previous], nonces: [] });
  let native = { plan: 'plus', status: 'available' };
  let lookups = 0;
  let open = true;
  const f = fixture(t, [], store, {
    approvedRetryTaskDigest: createHash('sha256').update(previousId).digest('hex'),
    acceptStorefrontSubmissions: () => open,
    lookupAdmission: async () => {
      ++lookups;
      if (native instanceof Error) throw native;
      return native;
    }
  });
  const retry = { code, session, afterFailedTask: previousId };
  const lookup = () => f.vendure('query', { code });
  const check = (task) => f.vendure('task', { id: task.id, taskToken: task.taskToken });
  const initial = (await lookup()).body;
  assert.equal(initial.reason, 'verified_retry_available');
  assert.equal(initial.status, 'available');
  assert.equal(initial.task.id, previousId);
  assert.equal((await f.vendure('submit', { code, session })).body.id, previousId);
  assert.deepEqual((await f.vendure('submit', { ...retry, code: 'KC-' + 'Z'.repeat(15) })).body,
    { rejected: true });
  for (const blocked of [
    { plan: 'plus', status: 'reserved', reason: 'manual_review_required' },
    { plan: 'plus', status: 'used' },
    { plan: 'plus', status: 'disabled' },
    { plan: 'pro_5x', status: 'available' },
    null, new Error('offline')
  ]) {
    native = blocked;
    const blockedLookup = (await lookup()).body;
    assert.equal(blockedLookup.task.id, previousId);
    assert.notEqual(blockedLookup.status, 'available');
    assert.equal(blockedLookup.reason, blocked?.reason);
    assert.deepEqual((await f.vendure('submit', retry)).body, { rejected: true });
  }
  native = { plan: 'plus', status: 'available' };
  open = false;
  assert.deepEqual((await f.vendure('submit', retry)).body, { rejected: true });
  open = true;
  const next = await Promise.all([
    f.vendure('submit', retry), f.vendure('submit', retry), f.vendure('submit', retry)
  ]);
  const accepted = next[0].body;
  assert.equal(accepted.status, 'queued');
  assert.notEqual(accepted.id, previousId);
  assert(next.every(res => res.body.id === accepted.id));
  assert(lookups >= 4);
  assert.equal((await lookup()).body.task.id, accepted.id);
  assert.equal((await check(initial.task)).body.status, 'failed');
  assert.deepEqual(store.load().state.tasks.find(item => item.id === previousId), previous);

  const lease = (await f.worker('claim')).body.task;
  assert.equal(lease.id, accepted.id);
  await f.worker('result', {
    id: lease.id, leaseToken: lease.leaseToken, outcome: 'confirmed_failure',
    evidenceId: 'codexdaichong:route:' + lease.id
  });
  assert.equal((await lookup()).body.status, 'reserved');
  assert.equal((await f.vendure('submit', retry)).body.id, accepted.id);
  assert.equal((await f.worker('claim')).body.task, null);
});

test('approval cannot replay an unknown result or a failure that reached the native executor', async (t) => {
  const makeCode = (letter) => 'KC-' + letter.repeat(15);
  const codeForIndex = ['B', 'C', 'D', 'E'].map(makeCode);
  const store = memoryStore();
  const tasks = codeForIndex.map((code, i) => {
    const id = `${i + 1}1111111-1111-4111-8111-111111111111`;
    const outcome = ['awaiting_review', 'failed', 'failed', 'failed'][i];
    return {
      id, codeRef: store.fingerprint('code', code), plan: 'plus', status: outcome,
      updatedAt: Date.now(),
      ...(i === 1 && { upstreamJobId: 'started-upstream-job' }),
      result: {
        status: outcome,
        evidenceRef: store.fingerprint('evidence', 'codexdaichong:' + (i === 2 ? 'unproven' : 'route') + ':' + id)
      }
    };
  });
  store.commit(0, { tasks, nonces: [] });
  const f = fixture(t, [], store, {
    approvedRetryTaskIds: tasks.slice(0, -1).map(task => task.id),
    lookupAdmission: async () => assert.fail('cannot look up admission without an approved pre-execution failure')
  });
  for (const [index, code] of codeForIndex.entries()) {
    const response = (await f.vendure('query', { code })).body;
    assert.equal(response.status, 'reserved');
    assert.equal(response.task.id, tasks[index].id);
    assert.deepEqual((await f.vendure('submit', { code, session, afterFailedTask: tasks[index].id })).body,
      { rejected: true });
  }
  assert.equal((await f.worker('claim')).body.task, null);
});

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
  assert.deepEqual(Object.keys(view).sort(), ['accountEmail', 'id', 'message', 'plan', 'progress', 'stage', 'status', 'updatedAt']);
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
  assert.deepEqual(Object.keys(failed.body).sort(), ['accountEmail', 'id', 'message', 'plan', 'progress', 'stage', 'status', 'updatedAt']);
});

test('only explicit route and plan-card rejections before execution are definitive', async t => {
  for (const [code, status, explicit] of [
    ['recharge_route_unavailable', 409, true], ['recharge_route_unavailable', 409, false],
    ['recharge_plan_cards_unavailable', 503, true], ['recharge_plan_cards_unavailable', 503, false]
  ]) {
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
      return Response.json({ success: false, code,
        ...(explicit ? { execution_started: false } : {}) }, { status });
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
    if (url.pathname === '/api/admin/task-logs/original-job') return Response.json({ success: false });
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
  assert.equal(paths.some((path) => /cancel|retry|cards/.test(path)), false);
  assert(paths.filter(path => path.includes('/admin/')).every(path => path === '/api/admin/task-logs/original-job'));
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

test('a failed progress-table commit cannot cancel, change or resubmit a successful original recharge', async t => {
  const store = memoryStore();
  const f = fixture(t, undefined, store);
  const submitted = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  store.failWhen(state => state.tasks.some(task => task.status === 'running' && task.stage));
  const originalCalls = [];
  const privateValues = [session, 'synthetic-full-bank-number', 'synthetic-card-expiry', 'synthetic-cvc',
    'synthetic-private-log', '/private-screenshot', '/private-video', 'https://example.test/private-payment'];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.port === '31992') {
      const reply = await f.post(url.pathname, JSON.parse(options.body), options.headers);
      return Response.json(reply.body, { status: reply.status });
    }
    originalCalls.push({ path: url.pathname, method: options.method, body: options.body });
    if (url.pathname === '/api/public/runtime') return Response.json({ success: true });
    if (url.pathname === '/api/run-process') return Response.json({ success: true, jobKey: 'original-job' });
    assert.equal(url.pathname, '/api/task-status/original-job');
    return Response.json({ success: true, data: {
      jobKey: 'original-job', cdkCode: 'synthetic-code', status: 'success', isTerminal: true,
      session, card_number: privateValues[1], expiry: privateValues[2], cvc: privateValues[3],
      message: privateValues[4], screenshot: privateValues[5], video: privateValues[6], checkoutUrl: privateValues[7]
    } });
  });
  const run = createVendureCodexdaichongWorker({
    bridgeUrl: 'http://127.0.0.1:31992', upstreamUrl: 'http://127.0.0.1:31993',
    workerSecret: f.workerSecret, upstreamSecret: randomBytes(32).toString('hex'), pollIntervalMs: 1
  });
  assert.deepEqual(await run(), { status: 'succeeded' });
  assert.equal(store.failures, 1);
  assert.deepEqual(originalCalls.filter(call => call.method !== 'GET'), [{
    path: '/api/run-process', method: 'POST', body: JSON.stringify({ cdk: 'synthetic-code', session })
  }]);
  const view = (await f.vendure('task', { id: submitted.id, taskToken: submitted.taskToken })).body;
  assert.equal(view.message, '开通成功');
  assert.deepEqual(Object.keys(view).sort(), ['accountEmail', 'id', 'message', 'plan', 'progress', 'stage', 'status', 'updatedAt']);
  for (const value of privateValues) assert.equal(JSON.stringify(view).includes(value), false);
  assert.equal(JSON.stringify(store.load()).includes(session), false);
  assert.deepEqual(await run(), { status: 'idle' });
  assert.equal(originalCalls.filter(call => call.method === 'POST').length, 1);
});

test('a lost committed result is recovered from the same receipt without delivering authorization twice', async t => {
  const store = memoryStore();
  const f = fixture(t, undefined, store);
  const submitted = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  store.failWhen(state => state.tasks.some(task => task.status === 'succeeded'), true);
  let activations = 0;
  let resultWrites = 0;
  const resultBodies = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.port === '31992') {
      if (url.pathname.endsWith('/result')) { resultWrites++; resultBodies.push(options.body); }
      const reply = await f.post(url.pathname, JSON.parse(options.body), options.headers);
      return Response.json(reply.body, { status: reply.status });
    }
    if (url.pathname === '/api/public/runtime') return Response.json({ success: true });
    if (url.pathname === '/api/run-process') { activations++; return Response.json({ success: true, jobKey: 'original-job' }); }
    assert.equal(url.pathname, '/api/task-status/original-job');
    return Response.json({ success: true, data: {
      jobKey: 'original-job', cdkCode: 'synthetic-code', status: 'success', isTerminal: true
    } });
  });
  const options = {
    bridgeUrl: 'http://127.0.0.1:31992', upstreamUrl: 'http://127.0.0.1:31993',
    workerSecret: f.workerSecret, upstreamSecret: randomBytes(32).toString('hex'), pollIntervalMs: 1
  };
  await assert.rejects(createVendureCodexdaichongWorker(options)(),
    error => error.message === '无法确认回执已写入，请按原任务核对');
  assert.equal(resultWrites, 2);
  assert.equal(resultBodies[0], resultBodies[1]);
  assert.equal(store.load().state.tasks[0].status, 'succeeded');
  const reopened = fixture(t, undefined, store);
  const current = await reopened.vendure('task', { id: submitted.id, taskToken: submitted.taskToken });
  assert.equal(current.body.status, 'succeeded');
  assert.equal(current.body.message, '开通成功');
  assert.deepEqual((await reopened.worker('claim')).body, { task: null });
  assert.equal(activations, 1);
  assert.equal(JSON.stringify(store.load()).includes(session), false);
});

test('customer steps require complete card evidence, distinguish page URL from opened page, and reset on retry', async () => {
  const { customerFacts, projectCustomerProgress } = await import('../modules/recharge/vendure/customer-progress.mjs');
  const base = Date.now() - 10000;
  const texts = [
    '✅ [步骤] Session 登录成功: customer@example.test',
    'CHECKOUT_SOURCE: api',
    '✅ [步骤] Checkout 页面已打开，开始信用卡支付流程...',
    '[Stripe] ✅ 卡号已填写 (iframe[0])',
    '[Stripe] ✅ 有效期已填写 (iframe[1])',
    '[Stripe] ✅ CVC 已填写 (iframe[2])',
    '[Stripe] ✅ 账单地址已填写',
    '[Stripe] ✅ 已点击提交按钮 (订阅)'
  ];
  const payload = count => ({ success: true, task: { jobKey: 'safe-job', cdk: 'synthetic-code', status: 'running' },
    runtimeEntries: texts.slice(0, count).map((text, index) => ({ text, id: index + 1, ts: base + index, jobKey: 'safe-job', source: 'spawn/a1/stdout' })) });
  assert.equal(customerFacts(payload(2), 'safe-job', 'synthetic-code').find(step => step.key === 'checkout').state, 'active');
  assert(!customerFacts(payload(5), 'safe-job', 'synthetic-code').some(step => step.key === 'card' && step.state === 'complete'));
  const facts = customerFacts(payload(8), 'safe-job', 'synthetic-code');
  for (const key of ['account', 'checkout', 'card', 'billing']) assert.equal(facts.find(step => step.key === key).state, 'complete');
  assert.equal(facts.find(step => step.key === 'payment').state, 'waiting');
  assert(!JSON.stringify(facts).includes('customer@example.test'));
  assert.deepEqual(customerFacts(payload(8), 'wrong-job', 'synthetic-code'), []);
  assert.deepEqual(customerFacts(payload(8), 'safe-job', 'wrong-code'), []);
  const initial = projectCustomerProgress({ id: '11111111-1111-4111-8111-111111111111', status: 'queued' }, null, base);
  const running = projectCustomerProgress({ ...initial, status: 'running', stage: 'processing' }, initial, base + 10, facts);
  const heartbeat = projectCustomerProgress(running, running, base + 100, facts);
  assert.deepEqual(heartbeat.progress, running.progress);
  const retry = payload(8);
  retry.runtimeEntries.push({ id: 9, text: '[Stripe] 换卡重试 #1：更换卡号并重新提交...', ts: base + 20, jobKey: 'safe-job', source: 'spawn/a1/stdout' });
  const retried = projectCustomerProgress(running, running, base + 30, customerFacts(retry, 'safe-job', 'synthetic-code'));
  assert.equal(retried.progress.milestones.find(step => step.key === 'card').state, 'active');
  assert(!retried.progress.milestones.some(step => step.key === 'billing' || step.key === 'payment'));
  assert(retried.progress.retryAt);
  const late = projectCustomerProgress(retried, retried, base + 40, facts);
  assert.deepEqual(late.progress, retried.progress);
});

test('private task stream sends committed progress once, ignores heartbeat, and closes at the terminal receipt', async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { readProgressStream } = await import('../modules/recharge/vendure/progress-stream.mjs');
  const vendureKey = randomBytes(32).toString('hex'), workerSecret = randomBytes(32).toString('hex');
  const bridge = createLoopbackVendureRechargeBridge({ codes: [{ code: 'stream-code', plan: 'plus' }], vendureKey, workerSecret });
  const server = createServer((req, res) => void bridge.handle(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { bridge.close(); server.closeAllConnections(); server.close(); });
  const post = (action, body = {}, worker = false, extra = {}) => {
    const path = (worker ? rechargeWorkerPrefix : vendureRechargePrefix) + '/' + action;
    return fetch(origin + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json',
      ...(worker ? signRechargeWorkerRequest(workerSecret, path, JSON.stringify(body)) : {
        'x-vendure-recharge-key': vendureKey, 'x-vendure-client-ip': '203.0.113.10' }), ...extra } });
  };
  const task = await (await post('submit', { code: 'stream-code', session })).json();
  const denied = await post('task', { id: task.id, taskToken: 'incorrect' }, false, { accept: 'text/event-stream' });
  assert.equal(denied.status, 404); await denied.body.cancel();
  const stream = await post('task', { id: task.id, taskToken: task.taskToken }, false, { accept: 'text/event-stream' });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const snapshots = [];
  const consuming = readProgressStream(stream.body, snapshot => snapshots.push(snapshot));
  const lease = (await (await post('claim', {}, true)).json()).task;
  const update = { id: lease.id, leaseToken: lease.leaseToken, upstreamJobId: 'stream-job', stage: 'processing',
    facts: [{ key: 'card', state: 'complete', at: Date.now(), attempt: 1 }] };
  await (await post('progress', update, true)).body.cancel();
  await (await post('progress', update, true)).body.cancel();
  await (await post('result', { id: lease.id, leaseToken: lease.leaseToken, upstreamJobId: 'stream-job', outcome: 'confirmed_success', evidenceId: 'synthetic-receipt' }, true)).body.cancel();
  await consuming;
  assert.equal(snapshots.at(-1).status, 'succeeded');
  assert.equal(snapshots.filter(snapshot => snapshot.progress?.milestones.some(step => step.key === 'card') && snapshot.status === 'running').length, 1);
  assert(snapshots.every(snapshot => !Object.hasOwn(snapshot, 'taskToken')));
  assert.equal(snapshots[0].accountEmail, 'synthetic@example.test');
});

test('worker reads the pinned admin task-detail shape and sends only verified customer milestones', async t => {
  const f = fixture(t);
  const accepted = (await f.vendure('submit', { code: 'synthetic-code', session })).body;
  let activations = 0, reads = 0;
  const at = Date.now() - 100;
  const records = ['✅ [步骤] Session 登录成功: synthetic@example.test',
    '✅ [步骤] Checkout 页面已打开，开始信用卡支付流程...',
    '[Stripe] ✅ 卡号/有效期/CVC 已填写 (单 iframe 多 input)',
    '[Stripe] ✅ 账单地址已填写', '[Stripe] ✅ 已点击提交按钮 (订阅)'];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const path = new URL(input).pathname;
    if (new URL(input).port === '31992') {
      const reply = await f.post(path, JSON.parse(options.body), options.headers);
      return Response.json(reply.body, { status: reply.status });
    }
    if (path === '/api/public/runtime') return Response.json({ success: true });
    if (path === '/api/run-process') { activations++; return Response.json({ success: true, jobKey: 'observed-job' }); }
    if (path === '/api/admin/task-logs/observed-job') {
      const claims = JSON.parse(Buffer.from(options.headers['x-id-recharge-assertion'].split('.')[0], 'base64url'));
      assert.equal(claims.method, 'GET'); assert.equal(claims.path, path); assert.equal(claims.actor.sensitive, false);
      return Response.json({ success: true, task: { jobKey: 'observed-job', cdk: 'synthetic-code', status: 'running', rawOutput: 'synthetic-private-debug' },
        runtimeEntries: records.map((text, index) => ({ jobKey: 'observed-job', source: 'spawn/a1/stdout', ts: at + index, id: index + 1, text })) });
    }
    assert.equal(path, '/api/task-status/observed-job');
    return Response.json({ success: true, data: { jobKey: 'observed-job', cdkCode: 'synthetic-code',
      status: ++reads > 1 ? 'success' : 'running', isTerminal: reads > 1, message: '处理中' } });
  });
  const run = createVendureCodexdaichongWorker({ bridgeUrl: 'http://127.0.0.1:31992', upstreamUrl: 'http://127.0.0.1:31993',
    workerSecret: f.workerSecret, upstreamSecret: randomBytes(32).toString('hex'), pollIntervalMs: 1 });
  assert.equal((await run()).status, 'succeeded');
  const task = (await f.vendure('task', { id: accepted.id, taskToken: accepted.taskToken })).body;
  for (const key of ['account', 'checkout', 'card', 'billing']) assert.equal(task.progress.milestones.find(step => step.key === key)?.state, 'complete');
  assert.equal(task.progress.milestones.find(step => step.key === 'payment').state, 'waiting');
  assert.equal(task.status, 'succeeded'); assert.equal(activations, 1);
  assert(!JSON.stringify(task).includes('synthetic-private-debug'));
});
