import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  createRechargeCodeHandler, lookupRechargeCodeOwner
} from '../server/recharge-code-requests.mjs';

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

function setup(requests = []) {
  let document = { version: 0, data: { requests } };
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
  const addCodes = (codes, plan) => {
    for (const code of codes) {
      assert(!cardPool.has(code));
      cardPool.set(code, { code, plan_type: plan, type: '自助', status: 'unused', shipped: false });
    }
  };
  const transport = {
    async listCodeStock() {
      return [...cardPool.values()]
        .filter(row => row.code.length === 18 && row.status === 'unused' && !row.shipped)
        .map(row => ({ code: row.code, plan: row.plan_type }));
    },
    async checkReturns(items) {
      return items.map(item => {
        const row = cardPool.get(item.code);
        const eligible = row?.plan_type === item.plan && row.status === 'unused' && !row.shipped;
        return { ...item, state: eligible ? 'unused' : 'blocked', eligible, reason: eligible ? '可归还' : '不可归还' };
      });
    },
    async listCodes() { return [...cardPool.values()]; }
  };
  const start = () => createRechargeCodeHandler({ store, transport, publicOrigin: origin });
  return { audit, store, addCodes, cardPool, transport, start };
}

const application = { action: 'request', requestKey: 'application-1', plan: 'pro100', count: 2 };
const shortCodes = ['A', 'B', 'C', 'D'].map(letter => 'KC-' + letter.repeat(15));

test('short batch numbers stay stable across accounts, legacy reads, concurrent requests and restarts', async () => {
  const legacy = [
    { id: '22222222-2222-4222-8222-222222222222', applicantId: employee.id, status: 'pending', plan: 'pro100', count: 1, createdAt: '2026-11-08T00:00:00Z' },
    { id: '11111111-1111-4111-8111-111111111111', applicantId: other.id, status: 'rejected', plan: 'pro100', count: 1, createdAt: '2026-11-07T00:00:00Z' }
  ];
  const f = setup(legacy);
  f.addCodes(shortCodes, 'pro100');
  const own = (await call(f.start(), employee)).requests;
  assert.deepEqual(own.map(row => [row.id, row.batchNo]), [[legacy[0].id, 'PO000002']]);
  assert.equal((await call(f.start(), other)).requests[0].batchNo, 'PO000001');
  assert.deepEqual(f.store.load(), { version: 0, data: { requests: legacy } }, 'GET does not write or renumber stored history');
  assert.deepEqual(f.audit, []);
  const created = await Promise.all([0, 1, 2].map(n => call(f.start(), n === 1 ? other : employee,
    { ...application, requestKey: `concurrent-${n}`, count: 1, batchNo: 'PO999999' })));
  assert(created.every(result => result.status === 201));
  assert.deepEqual(created.map(result => result.request.batchNo).sort(), ['PO000003', 'PO000004', 'PO000005']);
  const persisted = f.store.load();
  assert.equal(new Set(persisted.data.requests.map(row => row.batchNo)).size, 5);
  assert.equal(persisted.data.requests.find(row => row.id === legacy[0].id).batchNo, 'PO000002');
  const replay = await call(f.start(), employee, { ...application, requestKey: 'concurrent-0', count: 1 });
  assert.equal(replay.status, 200);
  assert.equal(replay.request.batchNo, created[0].request.batchNo);
  assert.equal(replay.request.id, created[0].request.id);
  f.store.save(persisted.version, { requests: [...persisted.data.requests].reverse() }, { action: 'fixture_reorder' });
  const reloaded = (await call(f.start(), admin)).requests;
  for (const row of persisted.data.requests) assert.equal(reloaded.find(item => item.id === row.id).batchNo, row.batchNo);
  const next = await call(f.start(), employee, { ...application, requestKey: 'after-restart', count: 1 });
  assert.equal(next.request.batchNo, 'PO000006');
});

test('overview counts open applications for approvers without reading upstream or exposing codes', async () => {
  const { start, transport, audit } = setup([
    { status: 'pending', applicantId: employee.id, count: 40 },
    { status: 'issuing', applicantId: other.id, count: 2, codes: shortCodes.slice(0, 2) },
    { status: 'issued', applicantId: employee.id, codes: shortCodes.slice(2) },
    { status: 'rejected', applicantId: other.id }
  ]);
  const upstreamReads = [];
  for (const name of Object.keys(transport)) transport[name] = () => {
    upstreamReads.push(name);
    throw new Error('总览不应读取上游');
  };
  const summary = (handler, actor) => call(handler, actor, undefined, origin, '?view=pending-summary');
  const handle = start();
  assert.deepEqual(await summary(handle, admin), { status: 200, version: 0, pending: 2 });
  assert.deepEqual(await summary(handle, { ...admin, role: 'super' }), { status: 200, version: 0, pending: 2 });
  assert.equal((await summary(handle, employee)).status, 403);
  assert.equal((await summary(handle, null)).status, 401);
  assert.deepEqual(await summary(setup().start(), admin), { status: 200, version: 0, pending: 0 });
  assert.deepEqual(upstreamReads, []);
  assert.deepEqual(audit, []);
});

test('approval assigns existing codes and only the applicant can read them', async () => {
  const { audit, store, addCodes, start } = setup();
  addCodes(shortCodes.slice(0, 2), 'pro100');
  addCodes(shortCodes.slice(2, 3), 'plus');
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
  assert.equal((await call(handle, employee, { action: 'reject', id })).status, 403);
  assert.equal((await call(handle, employee, { action: 'reconcile', id })).status, 403);
  const otherBefore = await call(handle, other);
  assert.deepEqual(otherBefore.requests, []);
  assert.deepEqual(otherBefore.stock, { plus: 1, pro100: 2, pro200: 0, pro500: 0 });
  for (const code of shortCodes) assert(!JSON.stringify(otherBefore).includes(code));

  const approved = await call(handle, admin, { action: 'approve', id });
  assert.equal(approved.request.status, 'issued');
  assert.equal(approved.request.approvedById, admin.id);
  assert.equal(approved.request.codes, undefined);
  assert.equal((await call(handle, admin)).requests[0].codes, undefined);
  const { codes } = (await call(handle, employee)).requests[0];
  assert.deepEqual(codes, shortCodes.slice(0, 2));
  assert.deepEqual((await call(handle, other)).stock, { plus: 1, pro100: 0, pro200: 0, pro500: 0 });
  assert.deepEqual(lookupRechargeCodeOwner(store.load().data, codes[0].toLowerCase()), {
    requestId: id, employeeId: employee.id
  });
  assert.equal((await call(handle, admin, { action: 'approve', id })).request.status, 'issued');
  assert.equal((await call(handle, employee, application)).request.id, id);
  assert.deepEqual(audit.map(({ action }) => action), [
    'recharge_code_request', 'recharge_code_issued'
  ]);
  for (const code of codes) assert(!JSON.stringify(audit).includes(code));
});

test('independent approvers cannot assign the same remaining code, and insufficient stock leaves the application pending', async () => {
  const { store, addCodes, audit, start } = setup();
  addCodes(shortCodes.slice(0, 1), 'pro100');
  const handle = start();
  const command = { ...application, count: 1 };
  const first = (await call(handle, employee, command)).request;
  const second = (await call(handle, other, command)).request;
  const approvals = await Promise.all([first, second].map(row =>
    call(start(), admin, { action: 'approve', id: row.id })));
  assert.deepEqual(approvals.map(result => result.status).sort(), [200, 409]);
  const issued = store.load().data.requests.find(row => row.status === 'issued');
  const pending = store.load().data.requests.find(row => row.status === 'pending');
  assert.deepEqual(issued.codes, shortCodes.slice(0, 1));
  assert.equal(pending.codes, undefined);
  assert.equal((await call(handle, other, { ...command, requestKey: 'after-exhaustion' })).status, 409);
  assert.equal(audit.filter(row => row.action === 'recharge_code_issued').length, 1);
  addCodes(shortCodes.slice(1, 2), 'pro100');
  assert.equal((await call(start(), admin, { action: 'approve', id: pending.id })).request.status, 'issued');
  assert.deepEqual(store.load().data.requests.find(row => row.id === pending.id).codes, shortCodes.slice(1, 2));
});

test('issuing a batch does not add a store restriction and preserves historical issue data', async () => {
  const historical = {
    id: '33333333-3333-4333-8333-333333333333', applicantId: employee.id,
    status: 'issued', plan: 'plus', count: 1, codes: [shortCodes[3]],
    storefrontChannel: 'moyao-ai',
    storefrontAdmissions: [{ codeDigest: 'a'.repeat(64), deliveryReference: 'past-delivery' }]
  };
  const { store, addCodes, start } = setup([historical]);
  addCodes(shortCodes.slice(0, 2), 'pro100');
  const handle = start();
  const { request: { id } } = await call(handle, employee, application);
  const result = await call(handle, admin, { action: 'approve', id, storefrontChannel: 'moyao-ai' });
  assert.equal(result.request.status, 'issued');
  const requests = store.load().data.requests;
  const issued = requests.find(row => row.id === id);
  assert.equal(issued.storefrontChannel, undefined);
  assert.deepEqual(issued.codes, shortCodes.slice(0, 2));
  const old = requests.find(row => row.id === historical.id);
  assert.equal(old.storefrontChannel, historical.storefrontChannel);
  assert.deepEqual(old.storefrontAdmissions, historical.storefrontAdmissions);
  assert.equal((await call(handle, admin, { action: 'admit-storefront-code', id })).status, 400);
});

test('an unknown inventory is separate from zero and blocks both new applications and approvals', async () => {
  const { addCodes, store, transport, start } = setup();
  addCodes(shortCodes, 'pro100');
  const handle = start();
  const { request: { id } } = await call(handle, employee, application);
  transport.listCodeStock = async () => { throw new Error('upstream down'); };
  assert.equal((await call(handle, employee)).stock, null);
  assert.equal((await call(handle, employee, application)).request.id, id);
  assert.equal((await call(handle, employee, { ...application, requestKey: 'new-request' })).status, 503);
  assert.equal((await call(handle, admin, { action: 'approve', id })).status, 503);
  assert.equal(store.load().data.requests[0].status, 'pending');
  transport.listCodeStock = async () => [
    { code: shortCodes[0], plan: 'plus' }, { code: shortCodes[0], plan: 'pro100' }
  ];
  assert.equal((await call(handle, employee)).stock, null);
});

test('legacy interrupted requests only reconcile the original batch and rejected codes stay out of inventory', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const original = ['KC-' + 'A'.repeat(28), 'KC-' + 'B'.repeat(28)];
  const legacy = { id, plan: 'pro100', count: 2, status: 'issuing', applicantId: employee.id,
    applicantName: employee.name, codes: original, importStartedAt: '2026-11-09T00:00:00Z' };
  const { addCodes, start, store } = setup([legacy]);
  addCodes(original.slice(0, 1), 'pro100');
  addCodes(shortCodes, 'pro100');
  let result = await call(start(), admin, { action: 'reconcile', id });
  assert.equal(result.request.status, 'issuing');
  assert.match(result.request.issueProblem, /原码未全部核对成功/);
  assert.equal((await call(start(), employee)).requests[0].codes, undefined);
  addCodes(original.slice(1), 'pro100');
  result = await call(start(), admin, { action: 'reconcile', id });
  assert.equal(result.request.status, 'issued');
  assert.deepEqual((await call(start(), employee)).requests[0].codes, original);
  assert.deepEqual(lookupRechargeCodeOwner(store.load().data, original[0]), { requestId: id, employeeId: employee.id });

  const rejectedFixture = setup([{ ...legacy, codes: shortCodes.slice(0, 2) }]);
  rejectedFixture.addCodes(shortCodes, 'pro100');
  const reject = await call(rejectedFixture.start(), admin, { action: 'reject', id, reason: '原批次未发放' });
  assert.equal(reject.request.status, 'rejected');
  assert.equal((await call(rejectedFixture.start(), employee)).stock.pro100, 2);
  assert.equal((await call(rejectedFixture.start(), admin, { action: 'approve', id })).status, 409);
});

test('issued codes use a single live status read and preserve privacy when the upstream is unavailable', async () => {
  const { transport, start, addCodes } = setup();
  addCodes(shortCodes, 'pro100');
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
  const comparable = ({ code, eligible, returnReason, ...row }) => row;
  assert.deepEqual(adminView.items.map(comparable), ownerView.items.map(comparable));
  assert(adminView.items.every(row => !row.code && !row.eligible && row.returnReason === '仅领码人可归还'));
  transport.listCodes = async () => { throw new Error('upstream down'); };
  const unavailable = await readCodes(employee);
  assert.deepEqual(unavailable.items.map(({ code }) => code), original.map(({ code }) => code));
  assert(unavailable.items.every(({ status, usedAt }) => status === 'unavailable' && usedAt === null));
});
