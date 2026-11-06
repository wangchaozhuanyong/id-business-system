import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRechargeCodeHandler, lookupRechargeCodeOwner } from '../server/recharge-code-requests.mjs';

const origin = 'https://id.example.test';
const employee = { id: 'employee-1', name: '员工甲', active: true, role: 'employee' };
const other = { id: 'employee-2', name: '员工乙', active: true, role: 'employee' };
const admin = { id: 'admin-1', name: '管理员', active: true, role: 'admin' };

async function call(handler, actor, body, requestOrigin = origin, query = '') {
  const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  request.method = body ? 'POST' : 'GET';
  request.url = '/api/local/recharge-codes' + query;
  request.headers = { origin: requestOrigin, 'content-type': 'application/json' };
  let status, result;
  const response = {
    writeHead(value, headers) {
      status = value;
      assert.equal(headers['Cache-Control'], 'no-store');
    },
    end(value) { result = JSON.parse(value); }
  };
  await handler(request, response, actor);
  return { status, ...result };
}

function setup() {
  let document = { version: 0, data: null };
  const audit = [];
  const store = {
    load: () => structuredClone(document),
    save(version, data, entry) {
      if (version !== document.version) throw Object.assign(new Error('version conflict'), { status: 409 });
      document = { version: version + 1, data: structuredClone(data) };
      audit.push(entry);
    }
  };
  const cardPool = new Map();
  const imported = [];
  const addCodes = (codes, plan) => {
    for (const code of codes) {
      assert(!cardPool.has(code), 'reconciliation must only import missing codes');
      cardPool.set(code, { code, plan_type: plan, type: '自助', status: 'unused', shipped: false });
    }
  };
  const transport = {
    async importCodes({ codes, plan }) {
      imported.push([...codes]);
      addCodes(codes, plan);
    },
    async listCodes() { return [...cardPool.values()]; }
  };
  const start = () => createRechargeCodeHandler({ store, transport, publicOrigin: origin });
  return { audit, store, addCodes, imported, transport, start };
}

const application = { action: 'request', requestKey: 'application-1', plan: 'pro100', count: 2 };

test('employees can apply idempotently, and the approved codes are visible only to their owner', async () => {
  const { audit, store, imported, start } = setup();
  const handle = start();
  assert.equal((await call(handle, null)).status, 401);
  assert.equal((await call(handle, employee, application, 'https://invalid.test')).status, 403);
  assert.equal((await call(handle, employee, { ...application, count: 101 })).status, 400);
  const created = await call(handle, employee, application);
  assert.equal(created.status, 201);
  const { id } = created.request;
  assert.equal(created.request.status, 'pending');
  assert.equal(created.request.codes, undefined);
  const replay = await call(handle, employee, application);
  assert.equal(replay.status, 200);
  assert.equal(replay.request.id, id);
  assert.equal((await call(handle, employee, { ...application, count: 1 })).status, 409);
  assert.equal((await call(handle, employee, { action: 'approve', id })).status, 403);
  assert.deepEqual((await call(handle, other)).requests, []);

  const approved = await call(handle, admin, { action: 'approve', id });
  assert.equal(approved.request.status, 'issued');
  assert.equal(approved.request.approvedById, admin.id);
  assert.equal(approved.request.codes, undefined);
  assert.equal((await call(handle, admin)).requests[0].codes, undefined);
  const { codes } = (await call(handle, employee)).requests[0];
  assert.equal(codes.length, 2);
  assert.equal(new Set(codes).size, 2);
  assert.deepEqual(imported, [codes]);
  assert.deepEqual(lookupRechargeCodeOwner(store.load().data, codes[0].toLowerCase()), {
    requestId: id, employeeId: employee.id
  });
  assert.equal((await call(handle, admin, { action: 'approve', id })).request.status, 'issued');
  assert.equal(imported.length, 1);
  assert.deepEqual(audit.map(({ action }) => action), [
    'recharge_code_request', 'recharge_code_approve', 'recharge_code_import_started', 'recharge_code_issued'
  ]);
  for (const code of codes) assert(!JSON.stringify(audit).includes(code));
});

test('partial import and lost responses keep the same batch across restart and publish only after full readback', async () => {
  const { store, addCodes, imported, transport, start } = setup();
  const handle = start();
  const { request: { id } } = await call(handle, employee, application);
  const importMissing = transport.importCodes;
  let batch;
  transport.importCodes = async ({ codes, plan }) => {
    batch = codes;
    const saved = store.load().data.requests[0];
    assert(saved.importStartedAt);
    assert.deepEqual(saved.codes, codes);
    addCodes(codes.slice(0, 1), plan);
    throw new Error('response lost');
  };
  const pending = await call(handle, admin, { action: 'approve', id });
  assert.equal(pending.request.status, 'issuing');
  assert(pending.request.issueProblem);
  assert.equal((await call(handle, employee)).requests[0].codes, undefined);
  assert.equal(lookupRechargeCodeOwner(store.load().data, batch[0]), null);
  transport.importCodes = importMissing;
  const restarted = start();
  assert.equal((await call(restarted, admin, { action: 'reconcile', id })).request.status, 'issued');
  assert.deepEqual((await call(restarted, employee)).requests[0].codes, batch);
  assert.deepEqual(imported, [batch.slice(1)]);
});

test('upstream conflicts stay hidden and rejected applications remain terminal', async () => {
  const { addCodes, transport, start } = setup();
  const handle = start();
  const { request: { id } } = await call(handle, employee, application);
  transport.importCodes = async ({ codes }) => addCodes(codes, 'plus');
  const conflict = await call(handle, admin, { action: 'approve', id });
  assert.equal(conflict.request.status, 'issuing');
  assert.match(conflict.request.issueProblem, /冲突/);
  assert.equal((await call(handle, employee)).requests[0].codes, undefined);

  const { request: pending } = await call(handle, employee, { ...application, requestKey: 'application-2' });
  assert.equal((await call(handle, admin, { action: 'reconcile', id: pending.id })).status, 409);
  const rejected = await call(handle, admin, { action: 'reject', id: pending.id, reason: '暂缓提取' });
  assert.equal(rejected.request.status, 'rejected');
  assert.equal(rejected.request.reason, '暂缓提取');
  assert.equal((await call(handle, admin, { action: 'approve', id: pending.id })).status, 409);
});

test('issued codes use a single live status read and preserve privacy when the upstream is unavailable', async () => {
  const { transport, start } = setup();
  const handle = start();
  const { request: { id } } = await call(handle, employee, { ...application, count: 4 });
  assert.equal((await call(handle, admin, { action: 'approve', id })).request.status, 'issued');
  const readOriginal = transport.listCodes;
  const original = await readOriginal();
  const usedAt = '2026-11-08 12:30:00';
  let reads = 0;
  transport.listCodes = async () => {
    reads++;
    return [
      original[0],
      { ...original[1], status: 'processing' },
      { ...original[2], status: 'used', used_at: usedAt }
    ];
  };
  const readCodes = actor => call(handle, actor, undefined, origin, '?view=codes');
  assert.deepEqual((await readCodes(other)).items, []);
  assert.equal(reads, 0);

  const ownerView = await readCodes(employee);
  assert.equal(reads, 1);
  assert.equal(ownerView.canApprove, false);
  assert.deepEqual(ownerView.items.map(({ code }) => code), original.map(({ code }) => code));
  assert.deepEqual(ownerView.items.map(({ status, usedAt }) => [status, usedAt]), [
    ['unused', null], ['processing', null], ['used', usedAt], ['unavailable', null]
  ]);

  const adminView = await readCodes(admin);
  assert.equal(reads, 2);
  assert.equal(adminView.canApprove, true);
  assert.deepEqual(adminView.items, ownerView.items.map(({ code, ...row }) => row));
  transport.listCodes = async () => { throw new Error('upstream down'); };
  const unavailable = await readCodes(employee);
  assert.deepEqual(unavailable.items.map(({ code }) => code), original.map(({ code }) => code));
  assert(unavailable.items.every(({ status, usedAt }) => status === 'unavailable' && usedAt === null));
});
