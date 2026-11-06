import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startPreview } from '../server/preview.mjs';
import {
  createLoopbackVendureRechargeBridge,
  rechargeWorkerPrefix,
  signRechargeWorkerRequest,
  vendureRechargePrefix
} from '../modules/recharge/vendure/loopback-bridge.mjs';

import {
  isolatedRechargeFilename,
  openIsolatedRechargeStore
} from '../modules/recharge/vendure/isolated-task-store.mjs';

const authorization = (extra = {}) =>
  JSON.stringify({
    user: { id: 'synthetic-user', email: 'synthetic@example.test' },
    accessToken: 'synthetic-access-token-for-test',
    ...extra
  });
const taskIdentity = ({ id, taskToken }) => ({ id, taskToken });

async function fixture(t, { durable = false, throughHost = false } = {}) {
  const vendureKey = randomBytes(32).toString('hex');
  const workerSecret = randomBytes(32).toString('hex');
  let at = Date.now();
  let store, bridge, server, origin, file, directory, fault;
  const storageKey = durable ? randomBytes(32) : undefined;
  if (durable) {
    const runtime = fileURLToPath(new URL('../.runtime', import.meta.url));
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(runtime, 'vendure-recharge-test-'));
    file = join(directory, isolatedRechargeFilename);
  }
  async function start() {
    if (file) store = openIsolatedRechargeStore({ file, storageKey });
    const injectedStore = store && {
      ...store,
      commit(expectedRevision, state) {
        const injection = fault;
        fault = undefined;
        if (injection === 'before') throw new Error('fixture failure before commit');
        const next = store.commit(expectedRevision, state);
        if (injection === 'after') throw new Error('fixture failure after commit');
        return next;
      }
    };
    bridge = createLoopbackVendureRechargeBridge({
      vendureKey,
      workerSecret,
      store: injectedStore,
      codes: [
        { code: 'fixture-a', plan: 'plus' },
        { code: 'fixture-b', plan: 'pro_5x' },
        { code: 'fixture-disabled', plan: 'pro_20x', disabled: true }
      ],
      now: () => at
    });
    if (throughHost) {
      const preview = await startPreview(0, { vendureRehearsal: bridge });
      server = preview.server;
      origin = new URL(preview.url).origin;
    } else {
      server = createServer(bridge.handle);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      origin = 'http://127.0.0.1:' + server.address().port;
    }
  }
  async function stop() {
    if (!server) return;
    bridge.close();
    await new Promise((resolve) => server.close(resolve));
    store?.close();
    server = store = undefined;
  }
  t.after(async () => {
    try {
      await stop();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
  await start();

  async function post(path, raw, headers) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  }

  const vendure = (action, body = {}, headers = {}) =>
    post(vendureRechargePrefix + '/' + action, JSON.stringify(body), {
      'x-vendure-recharge-key': vendureKey,
      'x-vendure-client-ip': '203.0.113.10',
      ...headers
    });
  function signed(action, body = {}) {
    const path = rechargeWorkerPrefix + '/' + action;
    const raw = JSON.stringify(body);
    const headers = signRechargeWorkerRequest(workerSecret, path, raw, at);
    return (replacement = raw, overrides = {}, target = path) =>
      post(target, replacement, { ...headers, ...overrides });
  }
  return {
    vendure,
    origin: () => origin,
    signed,
    worker: (action, body) => signed(action, body)(),
    restart: async () => {
      await stop();
      await start();
    },
    fault: (value) => {
      fault = value;
    },
    readFile: () => readFile(file),
    inspect: () => store.load(),
    openWithWrongKey: () => openIsolatedRechargeStore({ file, storageKey: randomBytes(32) }),
    advance: (ms) => {
      at += ms;
    }
  };
}

test('isolated site routes Vendure requests and keeps executor routes off the site listener', async (t) => {
  await assert.rejects(startPreview(0, {
    databasePath: ':memory:', authPath: 'unused', publicOrigin: 'https://id.example.test',
    vendureRehearsal: { handle() {} }
  }), /仅可挂载到独立回环站/);
  const { vendure, origin, restart } = await fixture(t, { durable: true, throughHost: true });
  const code = 'fixture-b';
  const session = authorization();
  assert.equal((await vendure('config', {}, { 'x-vendure-recharge-key': 'invalid' })).status, 401);
  assert.equal((await vendure('config', {}, { 'x-vendure-client-ip': 'invalid' })).status, 400);
  assert.equal((await vendure('verify', { code }, { Origin: origin() })).status, 403);
  assert.equal((await vendure('verify', { code })).body.plan, 'pro_5x');
  const [first, retry] = await Promise.all([
    vendure('submit', { code, session }), vendure('submit', { code, session })
  ]);
  assert.deepEqual(first, retry);
  assert.equal(first.body.status, 'queued');
  const taskRequest = taskIdentity(first.body);
  assert.equal((await vendure('task', taskRequest)).body.status, 'queued');
  const worker = await fetch(origin() + rechargeWorkerPrefix + '/claim', { method: 'POST' });
  assert.equal(worker.status, 405);
  await restart();
  assert.equal((await vendure('query', { code })).body.task.id, first.body.id);
  assert.equal((await vendure('task', taskRequest)).body.status, 'awaiting_review');
  assert.equal((await vendure('submit', { code, session })).body.id, first.body.id);
});

test('Vendure verify, submit, query and task preserve one receipt across concurrent delivery and a lost result reply', async (t) => {
  const { vendure, worker } = await fixture(t);
  const code = 'fixture-a';
  const session = authorization();
  assert.deepEqual(await vendure('config'), { status: 200, body: { maintenance: false } });
  assert.deepEqual((await vendure('verify', { code })).body, {
    plan: 'plus',
    status: 'available'
  });
  assert.deepEqual((await vendure('submit', { code, session: '{}' })).body, { rejected: true });
  assert.deepEqual(
    (
      await vendure('submit', {
        code,
        session: authorization({ expires: '2000-01-01T00:00:00Z' })
      })
    ).body,
    { rejected: true }
  );
  assert.equal((await vendure('verify', { code: 'fixture-disabled' })).body.status, 'disabled');
  assert.deepEqual((await vendure('submit', { code: 'fixture-disabled', session })).body, {
    rejected: true
  });
  assert.deepEqual((await worker('claim')).body, { task: null });
  assert.equal((await vendure('submit', { code, session, plan: 'pro_20x' })).status, 400);

  const [first, duplicate] = await Promise.all([
    vendure('submit', { code, session }),
    vendure('submit', {
      code,
      session: authorization({
        user: {
          id: 'different-user',
          email: 'different@example.test'
        }
      })
    })
  ]);
  const accepted = first.body;
  assert.equal(first.status, 200);
  assert.deepEqual(accepted, duplicate.body);
  assert.equal(accepted.plan, 'plus');
  assert.equal(accepted.status, 'queued');
  assert.deepEqual(Object.keys(accepted).sort(), [
    'id',
    'plan',
    'status',
    'taskToken',
    'updatedAt'
  ]);
  assert.deepEqual((await vendure('query', { code })).body, {
    plan: 'plus',
    status: 'reserved',
    task: accepted
  });
  assert.equal((await vendure('task', { id: accepted.id, taskToken: 'forged' })).status, 404);

  const [one, two] = await Promise.all([worker('claim'), worker('claim')]);
  const claimed = one.body.task ?? two.body.task;
  assert.equal([one, two].filter(({ body }) => body.task).length, 1);
  assert.equal(claimed.id, accepted.id);
  assert.equal(claimed.status, 'running');
  assert.match(claimed.session, /@example\.test/);
  assert.equal(claimed.taskToken, undefined);
  assert.equal((await vendure('task', taskIdentity(accepted))).body.status, 'running');

  const result = {
    id: claimed.id,
    leaseToken: claimed.leaseToken,
    outcome: 'confirmed_success',
    evidenceId: 'fixture-provider:123'
  };
  assert.equal((await worker('result', { ...result, leaseToken: 'forged' })).status, 404);
  assert.equal((await worker('result', { ...result, evidenceId: undefined })).status, 400);
  const recorded = await worker('result', result);
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.status, 'succeeded');
  assert.deepEqual(recorded, await worker('result', result));
  assert.equal((await worker('result', { ...result, outcome: 'confirmed_failure' })).status, 409);
  assert.deepEqual((await vendure('task', taskIdentity(accepted))).body, recorded.body);
  assert(Date.parse(recorded.body.updatedAt) > Date.parse(claimed.updatedAt));
  assert.equal((await vendure('query', { code })).body.status, 'used');
  const second = (await vendure('submit', { code: 'fixture-b', session })).body;
  const secondLease = (await worker('claim')).body.task;
  const failed = {
    id: second.id,
    leaseToken: secondLease.leaseToken,
    outcome: 'confirmed_failure',
    evidenceId: 'fixture-provider:456'
  };
  assert.equal((await worker('result', { ...failed, evidenceId: result.evidenceId })).status, 409);
  assert.equal((await worker('result', failed)).body.status, 'failed');
  assert.equal((await vendure('query', { code: 'fixture-b' })).body.status, 'reserved');
  assert.deepEqual((await worker('claim')).body, { task: null });
});

test('worker signatures bind the path and exact request body and reject replay and stale signatures', async (t) => {
  const { vendure, signed, worker, advance } = await fixture(t);
  const submit = { code: 'fixture-a', session: authorization() };
  assert.equal(
    (await vendure('submit', submit, { 'x-vendure-recharge-key': 'forged' })).status,
    401
  );
  assert.equal((await vendure('submit', submit, { Origin: 'http://127.0.0.1' })).status, 403);
  const pending = await vendure('submit', submit);
  const fresh = signed('claim');
  const stale = signed('claim');
  assert.equal((await fresh('{"different":true}')).status, 401);
  assert.equal((await fresh(undefined, {}, rechargeWorkerPrefix + '/result')).status, 401);
  const leased = (await fresh()).body.task;
  assert.equal(leased.id, pending.body.id);
  assert.equal((await fresh()).status, 409);
  advance(31_000);
  assert.equal((await stale()).status, 401);

  const signedResult = { id: leased.id, leaseToken: leased.leaseToken, outcome: 'unknown' };
  assert.equal((await worker('result', signedResult)).body.status, 'awaiting_review');
  assert.equal((await vendure('query', { code: submit.code })).body.status, 'reserved');
  assert.deepEqual((await worker('claim')).body, { task: null });
});

test('lease expiry never reissues an attempt and expired queued credentials are never sent to a worker', async (t) => {
  const { vendure, worker, advance } = await fixture(t);
  const first = (await vendure('submit', { code: 'fixture-a', session: authorization() })).body;
  const leased = (await worker('claim')).body.task;
  advance(301_000);
  assert.deepEqual((await worker('claim')).body, { task: null });
  assert.equal((await vendure('task', taskIdentity(first))).body.status, 'awaiting_review');
  assert.equal(
    (
      await worker('result', {
        id: leased.id,
        leaseToken: leased.leaseToken,
        outcome: 'confirmed_success',
        evidenceId: 'late-proof'
      })
    ).status,
    409
  );
  const second = (await vendure('submit', { code: 'fixture-b', session: authorization() })).body;
  advance(601_000);
  assert.deepEqual((await worker('claim')).body, { task: null });
  assert.equal((await vendure('task', taskIdentity(second))).body.status, 'awaiting_review');
  assert.equal(
    (await vendure('submit', { code: 'fixture-b', session: authorization() })).body.id,
    second.id
  );
});

test('durable receipts, reservations and replay protection survive reopening without storing authorization', async (t) => {
  const f = await fixture(t, { durable: true });
  const session = authorization();
  const first = (await f.vendure('submit', { code: 'fixture-a', session })).body;
  const originalClaim = f.signed('claim');
  const lease = (await originalClaim()).body.task;
  const result = {
    id: lease.id,
    leaseToken: lease.leaseToken,
    outcome: 'confirmed_success',
    evidenceId: 'secret-fixture-provider-evidence'
  };
  const recorded = await f.worker('result', result);
  assert.equal(recorded.body.status, 'succeeded');
  assert.throws(() => f.openWithWrongKey(), /校验失败/);
  const text = (await f.readFile()).toString('utf8');
  for (const value of [
    session,
    'synthetic-access-token-for-test',
    'synthetic@example.test',
    'fixture-a',
    result.evidenceId,
    lease.leaseToken,
    first.taskToken
  ])
    assert.equal(text.includes(value), false);
  assert.equal(f.inspect().state.tasks[0].status, 'succeeded');
  assert.match(f.inspect().state.tasks[0].result.receiptRef, /^[a-f0-9]{64}$/);

  await f.restart();
  assert.equal((await originalClaim()).status, 409);
  assert.deepEqual(await f.vendure('task', taskIdentity(first)), recorded);
  const duplicate = await f.vendure('submit', { code: 'fixture-a', session });
  assert.equal(duplicate.body.id, first.id);
  assert.equal(duplicate.body.taskToken, first.taskToken);
  assert.deepEqual(await f.worker('result', result), recorded);
  assert.deepEqual((await f.worker('claim')).body, { task: null });
  assert.equal((await f.vendure('query', { code: 'fixture-a' })).body.status, 'used');
});

test('reopening puts running and unclaimed tasks into review without restoring short-lived authorization', async (t) => {
  const f = await fixture(t, { durable: true });
  const session = authorization();
  const first = (await f.vendure('submit', { code: 'fixture-a', session })).body;
  const lease = (await f.worker('claim')).body.task;
  const second = (await f.vendure('submit', { code: 'fixture-b', session })).body;
  assert.equal(second.status, 'queued');
  await f.restart();

  for (const original of [first, second]) {
    const current = await f.vendure('task', taskIdentity(original));
    assert.equal(current.body.status, 'awaiting_review');
    assert(Date.parse(current.body.updatedAt) > Date.parse(original.updatedAt));
  }
  assert.equal(
    (
      await f.worker('result', {
        id: first.id,
        leaseToken: lease.leaseToken,
        outcome: 'confirmed_success',
        evidenceId: 'fixture-late'
      })
    ).status,
    409
  );
  assert.deepEqual((await f.worker('claim')).body, { task: null });
  assert.equal((await f.vendure('submit', { code: 'fixture-b', session })).body.id, second.id);
  assert(f.inspect().state.tasks.every((task) => !('session' in task)));
});

test('failed commits never acknowledge submission, credential delivery or success, and a lost committed reply recovers once', async (t) => {
  const f = await fixture(t, { durable: true });
  const session = authorization();
  const submit = () => f.vendure('submit', { code: 'fixture-a', session });
  f.fault('before');
  assert.equal((await submit()).status, 503);
  assert.equal((await f.vendure('query', { code: 'fixture-a' })).body.status, 'available');
  assert.equal(f.inspect().state.tasks.length, 0);

  const accepted = (await submit()).body;
  f.fault('before');
  const noLease = await f.worker('claim');
  assert.equal(noLease.status, 503);
  assert.equal(noLease.body.task, undefined);
  assert.equal((await f.vendure('task', taskIdentity(accepted))).body.status, 'queued');
  const leased = (await f.worker('claim')).body.task;
  assert.equal(leased.session, session);
  const result = {
    id: leased.id,
    leaseToken: leased.leaseToken,
    outcome: 'confirmed_success',
    evidenceId: 'fixture-provider-atomic'
  };
  f.fault('before');
  assert.equal((await f.worker('result', result)).status, 503);
  assert.equal((await f.vendure('task', taskIdentity(accepted))).body.status, 'running');
  assert.equal(f.inspect().state.tasks[0].status, 'running');

  f.fault('after');
  assert.equal((await f.worker('result', result)).status, 503);
  assert.equal(f.inspect().state.tasks[0].status, 'succeeded');
  assert.equal((await f.vendure('task', taskIdentity(accepted))).status, 503);
  await f.restart();
  const current = await f.vendure('task', taskIdentity(accepted));
  assert.equal(current.body.status, 'succeeded');
  assert.deepEqual(await f.worker('result', result), current);
  assert.deepEqual((await f.worker('claim')).body, { task: null });
  assert.equal((await submit()).body.id, accepted.id);
  assert.equal(f.inspect().state.tasks.length, 1);
});
