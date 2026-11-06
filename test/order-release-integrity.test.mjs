import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { buildRechargeOrder } from '../server/recharge-order-sync.mjs';

test('自动入单按来源任务去重，迟到回执只补缺项并保留人工备注', (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const at = Date.parse('2026-11-07T02:00:00.000Z');
  const row = { jobKey: 'receipt-fixture', checkedAt: at, needs: ['实扣金额待核对'] };
  const evidence = {
    jobKey: row.jobKey, email: 'order@example.test', plan: 'Plus', employeeId: 'employee-fixture',
    start: '', expiry: '', completedAt: '', paidAmount: '', paidCurrency: '',
    paymentId: '4321', cardId: ''
  };
  const first = store.applyRechargeOrder({ since: at, row, order: buildRechargeOrder(evidence, {}, at) });
  const original = store.load('commerce');
  original.data.orders[0].notes = '人工补充的备注';
  original.data.orders[0].version++;
  store.saveBatch([{ domain: 'commerce', version: original.version, data: original.data, action: '更正订单' }]);
  const verified = {
    ...evidence, start: '2026-11-07T10:00', expiry: '2026-12-07T10:00',
    completedAt: '2026-11-07T02:00:00.000Z', paidAmount: '99.00', paidCurrency: 'PHP'
  };
  const repeat = store.applyRechargeOrder({ since: at, row, order: buildRechargeOrder(verified, {}, at) });
  assert.equal(repeat.orderNo, first.orderNo);
  const { orders } = store.load('commerce').data;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, original.data.orders[0].id);
  assert.equal(orders[0].createdById, 'employee-fixture');
  assert.equal(orders[0].paidAmount, '99.00');
  assert.equal(orders[0].expiry, '2026-12-07T10:00');
  assert.equal(orders[0].notes, '人工补充的备注');
  assert.equal(store.load('inventory').version, 0);
  assert.throws(() => store.load('order-sync'), /资料|模块/);
});
