import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { applyDocumentDelta, documentDelta } from '../modules/data/document-delta.mjs';
import { handleLocalBusiness } from '../server/local-business.mjs';
import { checkWriteReceipt } from '../server/write-operation.mjs';

const rows = (prefix, size) => Array.from({ length: size }, (_, index) =>
  ({ id: prefix + index, version: 1, notes: '合成资料'.repeat(200) }));
const commerce = size => ({ orders: rows('order-', size), customers: [], tenants: [], logs: [], operating: [], rentBatches: [] });
const inventory = size => ({ mailboxes: rows('mail-', size), accounts: rows('account-', size), batches: [],
  returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [] });

test('ordinary order and inventory changes send a bounded set of rows even with 10,000 historical records', () => {
  for (const size of [1000, 10_000]) for (const [domain, create, field] of [
    ['commerce', commerce, 'orders'], ['inventory', inventory, 'accounts']
  ]) {
    const prior = create(size);
    assert(Buffer.byteLength(JSON.stringify(prior)) > size * 1000);
    const current = structuredClone(prior);
    current[field][size - 1] = { ...current[field][size - 1], notes: '更新', version: 2 };
    const delta = documentDelta(domain, prior, current);
    assert(Buffer.byteLength(JSON.stringify(delta)) < 300);
    assert.deepEqual(applyDocumentDelta(domain, prior, delta), current);
    assert.equal(prior[field][size - 1].version, 1);
  }
});

test('multiple changed collections retain row order; unbounded and unsupported changes use the snapshot path', () => {
  const prior = commerce(200), next = structuredClone(prior);
  next.orders.unshift({ id: 'new' });
  next.logs.push({ id: 'new-log', entityId: 'new' });
  assert.deepEqual(applyDocumentDelta('commerce', prior, documentDelta('commerce', prior, next)), next);
  assert.equal(documentDelta('commerce', prior, { ...prior, renewalWarningHours: 48 }), undefined);
  assert.equal(documentDelta('commerce', prior, { ...prior, orders: [] }), undefined);
  const [change] = documentDelta('commerce', prior, next).filter(change => change.collection === 'orders');
  assert.equal(applyDocumentDelta('commerce', prior, [{ ...change, start: 201 }]), undefined);
  assert.equal(applyDocumentDelta('commerce', prior, [{ ...change, anchor: 'another-order' }]), undefined);
  assert.equal(applyDocumentDelta('commerce', prior, [{ ...change, collection: 'renewalWarningHours' }]), undefined);
});

test('sparse order saving uses the existing validator, document version and stable receipt across retries', async () => {
  const actor = { id: 'synthetic-manager', role: 'admin' };
  let current = { version: 5, data: commerce(2) };
  const receipts = new Map();
  const store = {
    load: () => current, featureDocument: () => ({ data: null }),
    replayWrite(operation) {
      return checkWriteReceipt(receipts.get(operation.domain), operation) && [{ ...current, domain: 'commerce' }];
    },
    saveBatch([write], { operation }) {
      assert.equal(write.version, current.version);
      assert.equal(write.data.orders.length, 2);
      assert.equal(write.data.orders[0].notes, '更新');
      current = { version: current.version + 1, data: write.data };
      receipts.set(operation.domain, { fingerprint: operation.fingerprint, domains: ['commerce'] });
      return [{ ...current, domain: 'commerce' }];
    }
  };
  const after = structuredClone(current.data);
  after.orders[0].notes = '更新';
  const body = { version: 5, delta: documentDelta('commerce', current.data, after) };
  async function call(payload, id = 'synthetic-operation-1') {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))]);
    Object.assign(request, { method: 'PUT', headers: {
      'content-type': 'application/json', origin: 'https://synthetic.invalid', 'x-id-operation': id
    } });
    let status, body;
    await handleLocalBusiness(request, { setHeader() {}, writeHead(value) { status = value; },
      end(value) { body = JSON.parse(value); } },
      '/api/local/commerce', store, actor, { publicOrigin: 'https://synthetic.invalid' });
    return { status, body };
  }
  const saved = await call(body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version, 6);
  assert.equal(saved.body.data, undefined);
  assert.deepEqual(applyDocumentDelta('commerce', commerce(2), saved.body.delta), current.data);
  assert.equal((await call(body)).status, 200);
  assert.equal(current.version, 6);
  assert.equal((await call(body, 'synthetic-operation-2')).status, 409);
  assert.equal((await call({ ...body, version: 6 })).status, 409);
  assert.equal((await call({ ...body, data: after })).status, 400);
  assert.equal(current.version, 6);
});
