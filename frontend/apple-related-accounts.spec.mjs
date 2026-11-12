import assert from 'node:assert/strict';
import test from 'node:test';
import { appleRelatedOrders } from './apple-funding.mjs';

const order = (id, changes = {}) => ({ id, orderNo: 'SYN-' + id, appleIdId: 'apple-a', payment: '苹果内购',
  email: 'subscriber@example.test', product: 'Claude Max', plan: 'Max 20x', customerId: 'customer-a',
  paidConfirmed: true, appleFunding: { bound: true }, ...changes });

test('关联查询保留每次原订单，余额分配与多条流水不重复生成订单行，也不改写资料', () => {
  const orders = [order('first'), order('renewal'), order('other-account', { email: 'other@example.test' })];
  const ledger = { allocations: [{ orderId: 'first', appleIdId: 'apple-a' }], movements: [
    { orderId: 'first', appleIdId: 'apple-a', kind: 'order-charge' },
    { orderId: 'first', appleIdId: 'apple-a', kind: 'order-reversal' }
  ] };
  const before = structuredClone({ orders, ledger });
  const result = appleRelatedOrders(orders, ledger).get('apple-a');
  assert.deepEqual(result.map(row => row.orderId), ['first', 'renewal', 'other-account']);
  assert.deepEqual(result.map(row => row.account), ['subscriber@example.test', 'subscriber@example.test', 'other@example.test']);
  assert.equal(result[0].historical, false);
  assert.deepEqual({ orders, ledger }, before);
});

test('待付款与撤单历史仍可查，未使用的草稿和其他付款渠道不冒充关联', () => {
  const orders = [order('pending', { paidConfirmed: false, appleFunding: undefined }),
    order('cancelled', { cancelled: true }), order('draft', { draft: true }),
    order('bank', { payment: '银行卡', appleFunding: undefined })];
  assert.deepEqual(appleRelatedOrders(orders).get('apple-a').map(row => row.orderId), ['pending', 'cancelled']);
  assert.deepEqual([...appleRelatedOrders([], { movements: [{ appleIdId: 'apple-a', kind: 'topup' }] })], []);
});

test('历史余额关联缺原订单或与当前付款 ID 不同，只展示历史快照，不冒认当前账号', () => {
  const orders = [order('changed', { appleIdId: 'apple-b', email: 'new@example.test' })];
  const ledger = { allocations: [{ orderId: 'missing', appleIdId: 'apple-a', orderNo: 'SYN-MISSING', email: 'old@example.test' }],
    movements: [{ orderId: 'changed', appleIdId: 'apple-a', email: 'before@example.test' },
      { orderId: 'unknown', appleIdId: 'apple-a' }] };
  const result = appleRelatedOrders(orders, ledger);
  assert.equal(result.get('apple-b')[0].account, 'new@example.test');
  assert.deepEqual(result.get('apple-a').map(row => [row.account, row.historical, Boolean(row.order)]),
    [['old@example.test', true, false], ['before@example.test', true, true], ['', true, false]]);
});

test('历史同单存在多个账号快照时全部保留，X 登录账号可以查询', () => {
  const result = appleRelatedOrders([order('x-order', { product: 'Grok', loginMethod: 'x',
    email: 'contact@example.test', xHandle: '@synthetic_user' })], {
    movements: [{ orderId: 'missing', appleIdId: 'apple-a', email: 'one@example.test' },
      { orderId: 'missing', appleIdId: 'apple-a', email: 'two@example.test' }]
  }).get('apple-a');
  assert.equal(result[0].account, '@synthetic_user');
  assert.deepEqual(result[1].accounts, ['one@example.test', 'two@example.test']);
  assert.equal(result[1].historical, true);
});

for (const size of [1000, 10000]) test(`${size} 条资料单次建立索引，不按苹果 ID 重复扫描订单`, () => {
  let reads = 0;
  const orders = Array.from({ length: size }, (_, i) => ({ ...order('large-' + i),
    get appleIdId() { reads++; return 'apple-' + i; } }));
  const ledger = { movements: orders.map((row, i) => ({ orderId: row.id, appleIdId: 'apple-' + i })) };
  const result = appleRelatedOrders(orders, ledger);
  assert.equal(result.size, size);
  assert.equal(result.get('apple-' + (size - 1))[0].orderId, 'large-' + (size - 1));
  assert.ok(reads <= size * 4, `${reads} reads`);
});
