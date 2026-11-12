import assert from 'node:assert/strict';
import test from 'node:test';
import { orderOpeningConfirmed } from '../frontend/order-opening.mjs';
import { projectSubscriptions } from '../server/subscription-management.mjs';

const now = Date.parse('2026-11-13T02:00:00Z');
const manual = (changes = {}) => ({
  id: 'synthetic-manual', orderNo: 'SYN-MANUAL', source: '管理员手工', product: 'Claude Pro',
  customerId: 'customer', plan: 'Pro', email: '', start: '2026-11-08T02:32', expiry: '2026-12-08T00:00',
  paidConfirmed: false, receiptConfirmed: false, costConfirmed: false, ...changes
});
const snapshots = orders => ({
  commerce: { version: 1, data: { orders, customers: [{ id: 'customer', name: '合成客户' }] } },
  inventory: { version: 1, data: { accounts: [], mailboxes: [] } },
  mailboxes: { version: 1, data: { items: [] } },
  subscriptions: { version: 0, data: null }
});

test('手工和历史已录入周期直接进入订阅中心，不要求财务确认或邮箱', () => {
  for (const source of ['管理员手工', '历史入库']) {
    for (const product of ['GPT', 'Claude Pro', 'Claude Max', 'Gemini', 'Grok']) {
      const data = snapshots([manual({ source, product })]);
      const before = structuredClone(data);
      const [row] = projectSubscriptions(data, now);
      assert.equal(row.status, 'active');
      assert.equal(row.history[0].confirmed, true);
      assert.equal(row.scope, 'unlinked', '没有邮箱仍保留原订单，而非伪造账号');
      assert.equal(row.missingAssociation, true);
      assert.deepEqual(data, before, '只读兼容旧单，不改写财务或订阅记录');
    }
  }
});

test('已录入周期按北京时间自动到期或未来生效，不产生额外确认任务', () => {
  const data = snapshots([manual()]);
  assert.equal(projectSubscriptions(data, Date.parse('2026-11-07T00:00:00Z'))[0].status, 'scheduled');
  assert.equal(projectSubscriptions(data, Date.parse('2026-12-07T15:59:59Z'))[0].status, 'active');
  assert.equal(projectSubscriptions(data, Date.parse('2026-12-07T16:00:00Z'))[0].status, 'expired');
});

test('客户资料缺失不把已登记订阅降为待开通，也不推断客户', () => {
  const [row] = projectSubscriptions(snapshots([manual({
    customerId: '', email: 'synthetic@example.test', source: '历史入库', tenantId: 'supplier'
  })]), now);
  assert.equal(row.status, 'active');
  assert.equal(row.history[0].confirmed, true);
  assert.equal(row.missingAssociation, true);
  assert.equal(row.customerId, '');
});

test('草稿、失败、明确待开通与无效周期不能被手工来源误当作已开通', () => {
  for (const changes of [{ draft: true }, { status: 'draft' }, { status: 'failed' },
    { entitlementStatus: 'pending' }, { entitlementStatus: 'failed' },
    { start: '' }, { expiry: '' }, { expiry: '2026-11-01' }]) {
    assert.equal(orderOpeningConfirmed(manual(changes), now), false, JSON.stringify(changes));
  }
});

test('自动代充仍按原任务成功结果，日期与金额不能替代成功回执', () => {
  const order = manual({ source: '线上代充', taskId: 'synthetic-task', paidConfirmed: true, receiptConfirmed: true });
  assert.equal(orderOpeningConfirmed(order, now), false);
  assert.equal(orderOpeningConfirmed({ ...order, rechargeCompletedAt: '2026-11-08T03:00' }, now), true);
  assert.equal(orderOpeningConfirmed({ ...order, entitlementStatus: 'active' }, now), true);
  assert.equal(orderOpeningConfirmed({ ...order, taskId: '', entitlementStatus: 'active' }, now), false);
});

test('明确待开通续费不覆盖现有已录入的有效手工订阅', () => {
  const original = manual({ email: 'synthetic@example.test' });
  const renewal = manual({ ...original, id: 'renewal', orderNo: 'SYN-RENEWAL', entitlementStatus: 'pending',
    start: '2026-11-12T10:00', expiry: '2026-12-12T10:00', paidConfirmed: true });
  const [row] = projectSubscriptions(snapshots([original, renewal]), now);
  assert.equal(row.status, 'active');
  assert.equal(row.series[0].orderNo, original.orderNo);
  assert.deepEqual(row.history.map(item => [item.orderNo, item.status]), [
    [renewal.orderNo, 'pending'], [original.orderNo, 'active']
  ]);
});
