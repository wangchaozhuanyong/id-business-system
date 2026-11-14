import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { recordEditCandidate, recordFingerprintInput } from '../modules/data/record-edit.mjs';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { mergeRecordEdit } from '../server/record-edit.mjs';

const actor = { id: 'synthetic-admin', name: '测试管理员', role: 'admin' };
const secondActor = { id: 'synthetic-second', name: '测试协作者', role: 'super' };
const origin = 'https://synthetic.invalid';
const actions = { commerce: '更正订单', inventory: 'inventory_edit' };
const domainCollection = { commerce: 'orders', inventory: 'mailboxes' };
const commerce = { customers: [], tenants: [], orders: [
  { id: 'first', orderNo: 'SYNTHETIC-1', version: 1, refunds: [], corrections: [], notes: '原备注' },
  { id: 'second', orderNo: 'SYNTHETIC-2', version: 1, refunds: [], corrections: [], notes: '原备注' }
], logs: [], operating: [], rentBatches: [] };
const inventory = { mailboxes: [
  { id: 'first', type: 'google', email: 'first@example.test', status: '正常', version: 1, notes: '原备注' },
  { id: 'second', type: 'google', email: 'second@example.test', status: '正常', version: 1, notes: '原备注' }
], accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [] };
function protocol(domain, row, notes, id = row.id) {
  return {
    collection: domainCollection[domain], id: row.id, expectedVersion: row.version,
    expectedFingerprint: createHash('sha256').update(recordFingerprintInput(domain, row)).digest('hex'),
    changes: { notes }, eventId: 'event-' + id,
    ...(domain === 'commerce' && { reason: '日常备注维护', logId: 'log-' + id })
  };
}

test('record edit accepts only one independent row with normal history; checkout, identity and batches stay strict', () => {
  for (const [domain, data] of Object.entries({ commerce, inventory })) {
    const collection = domainCollection[domain], row = data[collection][0];
    const edit = protocol(domain, row, '独立修改');
    const next = mergeRecordEdit(domain, actions[domain], edit, { data, version: 1 }, actor).data;
    const candidate = recordEditCandidate(domain, actions[domain], data, next);
    assert.equal(candidate.edit.id, row.id);
    assert.deepEqual(candidate.edit.changes, { notes: '独立修改' });
    assert.equal(next[collection][1], data[collection][1]);
    assert.equal(recordEditCandidate(domain, actions[domain], data, {
      ...next, [collection]: [{ ...next[collection][0], ...(domain === 'commerce' ? { paidAmount: '77' } : { email: 'changed@example.test' }) }, row]
    }), undefined);
    for (const changes of [{ customerId: 'change' }, { status: '冻结' }, { paidAmount: '1' }, JSON.parse('{"__proto__":{}}')])
      assert.throws(() => mergeRecordEdit(domain, actions[domain], { ...edit, changes }, { data, version: 1 }, actor),
        error => error.status === 400);
    const competing = structuredClone(data);
    competing[collection][0].notes = '同编号同版本但正文已变化';
    assert.throws(() => mergeRecordEdit(domain, actions[domain], edit, { data: competing, version: 2 }, actor),
      error => error.status === 409);
  }
});

test('transaction merges unrelated row saves, rejects stale same-row saves and replays exact receipts', async (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  store.saveBatch([{ domain: 'commerce', version: 0, data: structuredClone(commerce) },
    { domain: 'inventory', version: 0, data: structuredClone(inventory) }]);
  async function call(domain, body, operation, operator = actor) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, { method: 'PUT', headers: {
      origin, 'content-type': 'application/json', 'x-id-operation': operation
    } });
    let status, result;
    await handleLocalBusiness(request, { setHeader() {}, writeHead(value) { status = value; },
      end(value) { result = JSON.parse(value); } }, '/api/local/' + domain, store, operator, { publicOrigin: origin });
    return { status, result };
  }
  for (const domain of ['commerce', 'inventory']) {
    const base = store.load(domain), collection = domainCollection[domain];
    const [first, second] = base.data[collection];
    const one = { version: base.version, action: actions[domain], recordEdit: protocol(domain, first, '第一个人保存') };
    const two = { version: base.version, action: actions[domain], recordEdit: protocol(domain, second, '第二个人保存') };
    const saved = await Promise.all([
      call(domain, one, 'synthetic-first-' + domain),
      call(domain, two, 'synthetic-second-' + domain, secondActor)
    ]);
    assert.deepEqual(saved.map(row => row.status), [200, 200], JSON.stringify(saved.map(x => x.result?.error)));
    const current = store.load(domain);
    assert.deepEqual(current.data[collection].map(row => row.notes), ['第一个人保存', '第二个人保存']);
    assert.equal(current.version, base.version + 2);
    assert.equal((await call(domain, one, 'synthetic-first-' + domain)).status, 200);
    assert.equal(store.load(domain).version, current.version);
    assert.equal((await call(domain, one, 'synthetic-stale-' + domain)).status, 409);
    assert.equal((await call(domain, one, 'synthetic-deny-' + domain, { ...actor, role: 'finance' })).status, 403);
    assert.equal((await call(domain, { ...one, data: base.data }, 'synthetic-mixed-' + domain)).status, 400);
    assert.equal((await call('batch', [{ ...one, domain }], 'synthetic-batch-' + domain)).status, 400);
    if (domain === 'commerce') {
      assert.deepEqual(current.data.logs.map(row => row.actorId), [secondActor.id, actor.id]);
      assert.equal(current.data.orders[0].corrections[0].previous.notes, '原备注');
    } else {
      assert.equal(current.data.mailboxes[1].inventoryHistory[0].actorId, secondActor.id);
      assert.equal(new Map(current.data.undo).get('first').snapshot.notes, '原备注');
    }
  }
});
