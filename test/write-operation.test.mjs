import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { describeWriteOperation, checkWriteReceipt } from '../server/write-operation.mjs';
import { handleLocalBusiness } from '../server/local-business.mjs';

const id = 'operation-synthetic-0001', actor = { id: 'staff', name: '测试员工', role: 'admin' };
const data = { customers: [], tenants: [], orders: [], operating: [], rentBatches: [], logs: [] };
const body = { version: 0, data, action: '新增资料' };
test('operation identity is actor scoped, canonical and rejects changed-content replays', () => {
  const first = describeWriteOperation(id, actor, [{ ...body, domain: 'commerce' }]);
  const reordered = describeWriteOperation(id, actor, [{ domain: 'commerce', ...body }]);
  assert.deepEqual(first, reordered);
  assert.notEqual(first.domain, describeWriteOperation(id, { id: 'another' }, []).domain);
  const receipt = { fingerprint: first.fingerprint, domains: ['commerce'] };
  assert.deepEqual(checkWriteReceipt(receipt, first), ['commerce']);
  assert.throws(() => checkWriteReceipt(receipt, describeWriteOperation(id, actor, [])), { status: 409 });
  assert.throws(() => describeWriteOperation('bad', actor, []), { status: 400 });
  assert(!JSON.stringify(first).includes('customers'));
});
test('HTTP lost-response replay returns committed data without running a second write', async () => {
  let version = 0, saves = 0;
  const receipts = new Map();
  const store = { load: () => ({ version, data }),
    featureDocument: () => ({ version: 0, data: null }),
    replayWrite(operation) {
      const domains = checkWriteReceipt(receipts.get(operation.domain), operation);
      return domains && [{ domain: 'commerce', version, data }];
    },
    saveBatch(entries, { operation }) {
      assert.equal(entries[0].version, version);
      version++; saves++;
      receipts.set(operation.domain, { fingerprint: operation.fingerprint, domains: ['commerce'] });
      return [{ domain: 'commerce', version, data }];
    }
  };
  async function call(payload) {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))]);
    Object.assign(request, { method: 'PUT', url: '/api/local/commerce', headers: {
      host: 'id.test', origin: 'http://id.test', 'content-type': 'application/json', 'x-id-operation': id } });
    let status, result;
    await handleLocalBusiness(request, { setHeader() {}, writeHead(s) { status = s; }, end(value) { result = JSON.parse(value); } },
      request.url, store, actor);
    return { status, result };
  }
  assert.equal((await call(body)).status, 200);
  assert.equal((await call(body)).status, 200);
  assert.equal(saves, 1);
  assert.equal((await call({ ...body, version: 1 })).status, 409);
  assert.equal(saves, 1);
});
