import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createSubscriptionHandler } from '../server/subscription-management.mjs';

test('联系方式只投影到授权订阅，复制订阅信息不带姓名和联系方式', async () => {
  const origin = 'https://fixture.example.test';
  const actor = { id: 'qa-admin', role: 'admin' };
  const order = {
    id: 'qa-order', product: 'GPT', plan: 'Plus', email: 'renewal@example.test',
    customerId: 'qa-customer', start: '2026-10-09 15:00', expiry: '2026-11-09 15:00',
    source: '管理员手工', entitlementStatus: 'active', whatsapp: '+60 123456789'
  };
  const doc = data => ({ data, version: 1 });
  const snapshots = {
    commerce: doc({ orders: [order], customers: [
      { id: 'qa-customer', name: '内部测试姓名', wechat: 'internal-wechat', phone: '', telegram: '@qa_team' }
    ] }),
    inventory: doc({}), mailboxes: doc({}), subscriptions: doc({ renewalSuffixes: { [actor.id]: '请问需要续订吗？' } })
  };
  const audited = [];
  const handler = createSubscriptionHandler({ publicOrigin: origin, clock: () => Date.parse('2026-11-12T09:00:00Z'),
    store: { withSubscriptions: (_actor, action) => action(snapshots, (name, targets) => audited.push([name, targets])) } });
  async function request(action, data, user = actor) {
    const body = Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]), {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }
    });
    let status, result;
    await handler(body, { writeHead(code) { status = code; }, end(json) { result = JSON.parse(json); } },
      '/api/local/subscriptions/' + action, user);
    return { status, result };
  }
  const list = await request('list', { product: 'GPT', scope: 'expired', query: 'internal-wechat' });
  assert.equal(list.status, 200);
  const [row] = list.result.items;
  assert.deepEqual(row.contacts, { wechat: 'internal-wechat', whatsapp: '+60 123456789', telegram: '@qa_team' });
  assert.equal(row.history[0].contacts, undefined);
  const copied = await request('contact-copy', { id: row.id, orderId: order.id });
  assert.equal(copied.status, 200);
  assert.deepEqual(copied.result, { text: [
    '账号：renewal@example.test', '订阅套餐：Plus', '订阅时间：2026-10-09 15:00',
    '到期时间：2026-11-09 15:00', '到期提醒：已到期 3 天 2 小时', '请问需要续订吗？'
  ].join('\n') });
  assert.deepEqual(audited.at(-1), ['contact_copy', [row.id]]);
  assert.equal((await request('contact-copy', { orderId: order.id }, { ...actor, role: 'employee' })).status, 403);
  snapshots.commerce.data.customers.push({ id: 'other-customer', wechat: 'other-wechat' });
  snapshots.commerce.data.orders.push({ ...order, id: 'qa-other', customerId: 'other-customer' });
  const conflicting = await request('list', { product: 'GPT', scope: 'all' });
  assert.deepEqual(conflicting.result.items[0].contacts, {});
  assert.equal((await request('contact-copy', { orderId: order.id })).status, 409);
});
