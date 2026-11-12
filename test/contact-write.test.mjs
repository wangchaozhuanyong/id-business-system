import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeContactWrite } from '../server/contact-write.mjs';

const customer = id => ({ id, name: id, phone: id, version: 1 });
const base = () => ({ customers: [customer('a'), customer('b')], tenants: [], orders: [], operating: [], rentBatches: [], logs: [] });
function edit(id, source = base()) {
  const data = structuredClone(source), before = structuredClone(data.customers.find(row => row.id === id));
  const after = { ...before, name: id + ' edited', version: 2 };
  data.customers[data.customers.findIndex(row => row.id === id)] = after;
  const log = { id: 'edit-' + id, entityId: id, type: '修改资料' };
  data.logs.unshift(log);
  return { domain: 'commerce', action: '修改资料', version: 1, data,
    recordChange: { list: 'customers', before, after, log } };
}
test('different contacts merge without overwriting the earlier writer or their logs', () => {
  const a = mergeContactWrite(edit('a'), { version: 1, data: base() });
  const b = mergeContactWrite(edit('b'), { version: 2, data: a.data });
  assert.deepEqual(b.data.customers.map(row => row.name), ['a edited', 'b edited']);
  assert.equal(b.data.logs.length, 2); assert.equal(b.version, 2);
});
test('two editors of one contact conflict and cannot silently replace the first edit', () => {
  const first = mergeContactWrite(edit('a'), { version: 1, data: base() });
  assert.throws(() => mergeContactWrite(edit('a'), { version: 2, data: first.data }), { status: 409 });
});
test('only the stated contact and one audit entry may change; related business remains strict', () => {
  const bad = edit('a'); bad.data.orders.push({ id: 'unexpected' });
  assert.throws(() => mergeContactWrite(bad, { version: 1, data: base() }), { status: 409 });
  assert.throws(() => mergeContactWrite({ ...edit('a'), action: '更正订单' }, { version: 2, data: base() }), { status: 409 });
});
test('first contact is supported and concurrent same-name/contact creation is rejected', () => {
  const after = customer('new'), log = { id: 'new-log', entityId: after.id, type: '新增资料' };
  const data = { ...base(), customers: [after], logs: [log] };
  const write = { domain: 'commerce', version: 0, action: '新增资料', data,
    recordChange: { list: 'customers', before: null, after, log } };
  assert.equal(mergeContactWrite(write, { version: 0, data: null }).data.customers.length, 1);
  const current = { ...data, customers: [{ ...after, id: 'other-id' }], logs: [] };
  assert.throws(() => mergeContactWrite(write, { version: 1, data: current }), { status: 409 });
});
