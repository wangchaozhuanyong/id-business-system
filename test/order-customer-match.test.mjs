import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { matchOrderCustomer, orderCustomerCreateAction } from '../frontend/order-opening.mjs';

const customer = (id, name, wechat, active = true) => ({ id, name, wechat, active, version: 1 });
const customers = [
  customer('unique', '客户Ａ', 'Acme_123'),
  customer('first', '同名客户', 'first'),
  customer('second', '同名客户', 'second'),
  customer('disabled', '停用客户', 'disabled', false),
  customer('unverified', '微信空缺', '')
];

test('按完整姓名和微信匹配，重名与停用资料不触发随单建档', () => {
  const match = (name, wechat = '') => matchOrderCustomer(customers, name, wechat);
  assert.deepEqual(match(' 客户a '), { kind: 'matched', customerId: 'unique' });
  assert.equal(match('同名客户').kind, 'ambiguous');
  assert.deepEqual(match('同名客户', 'ＳＥＣＯＮＤ'), { kind: 'matched', customerId: 'second' });
  assert.equal(match('同名客户', 'different').kind, 'same-name');
  assert.equal(match('微信空缺', 'different').kind, 'ambiguous');
  assert.equal(match('另一姓名', 'first').kind, 'wechat-conflict');
  assert.equal(match('停用客户').kind, 'inactive');
  assert.equal(match('另一姓名', 'disabled').kind, 'inactive');
  assert.equal(match('全新客户', 'different').kind, 'new');
  assert.equal(matchOrderCustomer([...customers, customer('same-pair', '同名客户', 'second', false)], '同名客户', 'second').kind,
    'ambiguous');
});

test('随单建档校验当前版本和客户唯一性，订单失败不写入客户', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const actor = { id: 'qa-admin', name: '隔离录单员', role: 'admin' };
  const save = (version, data, action) => store.saveBatch([{ domain: 'commerce', version, data, action }], { actor })[0];
  const seeded = save(0, { customers: structuredClone(customers), orders: [], tenants: [], operating: [], rentBatches: [], logs: [] }, '新增资料');
  const pending = (snapshot, id, name, wechat) => {
    const data = structuredClone(snapshot);
    data.customers.unshift({ ...customer('customer-' + id, name, wechat), createdById: 'other', source: '不得随单写入' });
    data.orders.unshift({
      id, version: 1, product: 'GPT', plan: 'Plus', source: '管理员手工', businessType: '续费',
      customerId: 'customer-' + id, email: id + '@example.test', payment: '银行卡', paidAmount: '20',
      paidCurrency: 'PHP', saleAmount: '100', saleCurrency: 'CNY', paidConfirmed: true, receiptConfirmed: true,
      start: '2026-11-11T12:00', expiry: '2026-12-11T12:00', corrections: [], refunds: [], bankReturns: []
    });
    return data;
  };
  const create = (version, data) => save(version, data, orderCustomerCreateAction);
  const orphan = pending(seeded.data, 'orphan', '孤立客户', 'orphan');
  orphan.orders = [];
  assert.throws(() => create(seeded.version, orphan), { status: 400 });

  const invalid = pending(seeded.data, 'bad-order', '新客户', 'new_wechat');
  invalid.orders[0].paidAmount = '0';
  assert.throws(() => create(seeded.version, invalid), { status: 400 });
  assert.deepEqual(store.load('commerce'), { version: seeded.version, data: seeded.data });
  assert.equal(store.audit().length, 1);

  for (const [name, wechat] of [['客户a', 'different'], ['另一姓名', 'DISABLED'], ['新客户', 'second']])
    assert.throws(() => create(seeded.version, pending(seeded.data, 'duplicate', name, wechat)), { status: 409 });

  const competing = pending(seeded.data, 'other-tab', '新客户', 'ＮＥＷ＿ＷＥＣＨＡＴ');
  const saved = create(seeded.version, pending(seeded.data, 'new-order', '新客户', 'new_wechat'));
  assert.equal(saved.data.orders[0].customerId, saved.data.customers[0].id);
  assert.equal(saved.data.customers[0].createdById, actor.id);
  assert.equal(saved.data.customers[0].createdBy, actor.name);
  assert.equal(Object.hasOwn(saved.data.customers[0], 'source'), false);
  assert.throws(() => create(seeded.version, competing), { status: 409 });
  assert.throws(() => create(saved.version, pending(saved.data, 'other-tab', '新客户', 'NEW_WECHAT')), { status: 409 });
  assert.deepEqual(store.load('commerce'), { version: saved.version, data: saved.data });
});
